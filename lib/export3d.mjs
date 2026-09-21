import { existsSync, statSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parsePly, writeBinaryPly } from './ply.mjs';
import { writeGlb } from './glb.mjs';
import { readCameraPoses, gravityUpFromPoses } from './colmap.mjs';
import { bakeOrthophoto } from './texture.mjs';
import { buildTerrain, sampleTerrainHeight, trimFootprint } from './terrain.mjs';
import {
  applyRotation,
  boundsOf,
  centroid,
  classifyCoverage,
  compactCloud,
  densityFilter,
  pcaUp,
  rotationToYUp,
  scalePositions,
  subsampleCloud,
} from './geometry.mjs';

function usableCloud(path) {
  return path && existsSync(path) && statSync(path).size > 1024;
}

function rotatePoint(point, rotation, origin) {
  const x = point[0] - origin[0];
  const y = point[1] - origin[1];
  const z = point[2] - origin[2];
  return [
    rotation[0][0] * x + rotation[0][1] * y + rotation[0][2] * z,
    rotation[1][0] * x + rotation[1][1] * y + rotation[1][2] * z,
    rotation[2][0] * x + rotation[2][1] * y + rotation[2][2] * z,
  ];
}

function medianOf(values) {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Metric scale without GPS: the reconstruction is in arbitrary units, so we
 * measure how far the solved cameras fly above the reconstructed ground and
 * stretch that to the operator's stated altitude.
 */
function scaleFromFlightAltitude(grid, cameraCentres, altitude) {
  if (!cameraCentres.length || !(altitude > 0)) return null;
  const clearances = [];
  for (const centre of cameraCentres) {
    const ground = sampleTerrainHeight(grid, centre[0], centre[2]);
    if (!Number.isFinite(ground)) continue;
    const clearance = centre[1] - ground;
    if (clearance > 1e-4) clearances.push(clearance);
  }
  if (clearances.length < 3) return null;
  const median = medianOf(clearances);
  if (!(median > 1e-4)) return null;
  return { scale: altitude / median, clearance: median, samples: clearances.length };
}

export async function buildProducts({
  cloudPath,
  meshPath,
  outDir,
  workDir = null,
  altitude = 82,
  sourceName = 'single-pass.mp4',
  mode = 'view',
  surface = null,
}) {
  await mkdir(outDir, { recursive: true });
  const profiles = {
    fast: { resolution: 520, smoothing: 2, slope: 3.2, ortho: 1536, points: 180000 },
    balanced: { resolution: 720, smoothing: 2, slope: 4.5, ortho: 1792, points: 280000 },
    detailed: { resolution: 960, smoothing: 1, slope: 7, ortho: 2048, points: 400000 },
    full: { resolution: 960, smoothing: 1, slope: 7, ortho: 2048, points: 400000 },
    view: { resolution: 0, smoothing: 4, slope: 2, ortho: 1536, points: 240000 },
  };
  const profile = surface || profiles[mode] || profiles.view;
  const sourceCloud = usableCloud(cloudPath) ? cloudPath : meshPath;
  if (!usableCloud(sourceCloud)) throw new Error('Point cloud is empty or missing.');
  console.log(`Export ${mode}: cloud=${basename(sourceCloud)} grid=${profile.resolution || 'auto'} slope=${profile.slope}`);

  const parsed = parsePly(await readFile(sourceCloud));
  if (!parsed.vertexCount) throw new Error('Point cloud contains no vertices.');
  let cloud = compactCloud(parsed.positions, parsed.colors, parsed.normals);
  if (cloud.vertexCount < 64) throw new Error('Point cloud contains too few valid coordinates.');
  const denoised = densityFilter(cloud.positions, cloud.colors, 96, 3);
  cloud.positions = denoised.positions;
  cloud.colors = denoised.colors;
  cloud.vertexCount = denoised.positions.length / 3;

  const poses = workDir ? await readCameraPoses(workDir) : [];
  const gravityUp = gravityUpFromPoses(poses);
  const orientation = gravityUp ? 'colmap-cameras' : 'point-cloud-pca';
  const rotation = rotationToYUp(gravityUp || pcaUp(cloud.positions));
  const origin = centroid(cloud.positions);

  const aligned = applyRotation(cloud.positions, rotation, origin);
  const trimmed = trimFootprint(aligned, cloud.colors);
  const unscaledBox = boundsOf(trimmed.positions);

  const cameraCentres = poses.map((pose) => rotatePoint(pose.center, rotation, origin));
  const draft = buildTerrain(trimmed.positions, trimmed.colors, {
    resolution: profile.resolution,
    smoothing: profile.smoothing,
    slope: profile.slope,
    cameraXZ: cameraCentres.map((centre) => [centre[0], centre[2]]),
  });

  const baked = await bakeOrthophoto({
    workDir,
    grid: draft.grid,
    albedo: draft.albedo,
    rotation,
    origin,
    maxEdge: profile.ortho,
  });
  if (baked.cameras) {
    console.log(`Orthophoto: ${baked.width}x${baked.height} from ${baked.cameras} frames, ${(baked.coverage * 100).toFixed(0)}% photo coverage`);
  }

  const fit = scaleFromFlightAltitude(draft.grid, cameraCentres, altitude);
  const fallbackHeight = Math.max(1e-6, unscaledBox.max[1] - unscaledBox.min[1]);
  const scale = fit ? fit.scale : (altitude > 0 ? altitude / Math.max(fallbackHeight * 0.45, 1e-6) : 1);

  const scaledCloud = scalePositions(trimmed.positions, scale);
  const mesh = {
    positions: scalePositions(draft.positions, scale),
    colors: draft.colors,
    uvs: draft.uvs,
    indices: draft.indices,
    ortho: baked.png,
    textured: baked.coverage > 0.05,
  };

  const viewCloud = subsampleCloud(scaledCloud, trimmed.colors, profile.points);
  console.log(`Terrain: ${mesh.positions.length / 3} verts, ${mesh.indices.length / 3} faces, coverage ${(draft.coverage * 100).toFixed(0)}%`);
  const glb = writeGlb(mesh, viewCloud);

  const scaledBox = boundsOf(mesh.positions);
  const metadata = {
    source: sourceName,
    generatedAt: new Date().toISOString(),
    points: trimmed.positions.length / 3,
    meshVertices: mesh.positions.length / 3,
    meshFaces: mesh.indices.length / 3,
    altitudeM: altitude,
    metersPerUnit: 1,
    extentM: [
      scaledBox.max[0] - scaledBox.min[0],
      scaledBox.max[1] - scaledBox.min[1],
      scaledBox.max[2] - scaledBox.min[2],
    ],
    bbox: scaledBox,
    layers: classifyCoverage(scaledCloud, trimmed.colors),
    crs: 'local tangent plane, Y-up, metres (altitude-scaled)',
    orientation,
    cameraPoses: poses.length,
    scaleSource: fit ? 'flight-altitude' : 'scene-height-heuristic',
    groundSampleM: (scaledBox.max[0] - scaledBox.min[0]) / Math.max(1, draft.grid.cols - 1),
    coverage: draft.coverage,
    photoCoverage: baked.coverage,
    textureSize: [baked.width, baked.height],
    notes: [
      fit
        ? `Gravity from ${poses.length} solved cameras; scale set so the flight sits ${altitude} m above the reconstructed ground.`
        : poses.length
          ? `Gravity from ${poses.length} solved cameras; scale is a scene-height heuristic because flight clearance could not be measured.`
          : 'Gravity estimated from the point cloud; scale is a heuristic because camera poses were unavailable.',
      baked.cameras
        ? `Orthophoto baked from ${baked.cameras} undistorted frames (${(baked.coverage * 100).toFixed(0)}% of the surface has photographic colour).`
        : 'No source frames were available to bake a photographic texture.',
    ].join(' '),
    unscaledExtent: [
      unscaledBox.max[0] - unscaledBox.min[0],
      unscaledBox.max[1] - unscaledBox.min[1],
      unscaledBox.max[2] - unscaledBox.min[2],
    ],
    scaleApplied: scale,
    exportMode: mode,
  };

  const files = {
    glb: join(outDir, 'terrain.glb'),
    mesh: join(outDir, 'terrain.ply'),
    pointCloud: join(outDir, 'pointcloud.ply'),
    ortho: join(outDir, 'orthomosaic.png'),
    metadata: join(outDir, 'metadata.json'),
  };
  await writeFile(files.glb, glb);
  await writeFile(files.ortho, mesh.ortho);
  await writeFile(files.metadata, JSON.stringify(metadata, null, 2));
  await writeFile(files.mesh, writeBinaryPly(mesh.positions, mesh.colors, mesh.indices));
  const cloudOut = viewCloud || subsampleCloud(scaledCloud, trimmed.colors, 600000);
  await writeFile(files.pointCloud, writeBinaryPly(cloudOut.positions, cloudOut.colors, null));
  return { files, metadata, sourceCloud: basename(cloudPath) };
}
