import { readFile } from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { encodePng } from './png.mjs';
import { readUndistortedViews } from './colmap.mjs';

function rotateVec(v, R) {
  return [
    R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2],
    R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
    R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2],
  ];
}

function rotatePoint(point, rotation, origin) {
  return rotateVec([
    point[0] - origin[0],
    point[1] - origin[1],
    point[2] - origin[2],
  ], rotation);
}

function sampleBilinear(data, width, height, u, v) {
  const x = Math.max(0, Math.min(width - 1.001, u));
  const y = Math.max(0, Math.min(height - 1.001, v));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const i00 = (y0 * width + x0) * 3;
  const i10 = (y0 * width + x1) * 3;
  const i01 = (y1 * width + x0) * 3;
  const i11 = (y1 * width + x1) * 3;
  const mix = (a, b, t) => a + (b - a) * t;
  return [
    mix(mix(data[i00], data[i10], tx), mix(data[i01], data[i11], tx), ty),
    mix(mix(data[i00 + 1], data[i10 + 1], tx), mix(data[i01 + 1], data[i11 + 1], tx), ty),
    mix(mix(data[i00 + 2], data[i10 + 2], tx), mix(data[i01 + 2], data[i11 + 2], tx), ty),
  ];
}

function worldFromGrid(grid, col, row) {
  const { cols, rows, box, height } = grid;
  const spanX = Math.max(1e-6, box.max[0] - box.min[0]);
  const spanZ = Math.max(1e-6, box.max[2] - box.min[2]);
  return [
    box.min[0] + (col / Math.max(1, cols - 1)) * spanX,
    height[row * cols + col],
    box.min[2] + (row / Math.max(1, rows - 1)) * spanZ,
  ];
}

function rasterizeDepth(grid, camera, width, height) {
  const depth = new Float32Array(width * height).fill(1e30);
  const { cols, rows, mask } = grid;
  const fx = camera.fx * (width / camera.width);
  const fy = camera.fy * (height / camera.height);
  const cx = camera.cx * (width / camera.width);
  const cy = camera.cy * (height / camera.height);
  const project = (col, row) => {
    if (!mask[row * cols + col]) return null;
    const p = worldFromGrid(grid, col, row);
    const dx = p[0] - camera.center[0];
    const dy = p[1] - camera.center[1];
    const dz = p[2] - camera.center[2];
    const z = dx * camera.viewAxis[0] + dy * camera.viewAxis[1] + dz * camera.viewAxis[2];
    if (z < 1e-4) return null;
    const x = dx * camera.rightAxis[0] + dy * camera.rightAxis[1] + dz * camera.rightAxis[2];
    const y = dx * camera.downAxis[0] + dy * camera.downAxis[1] + dz * camera.downAxis[2];
    return { u: fx * (x / z) + cx, v: fy * (y / z) + cy, z };
  };
  const fill = (a, b, c) => {
    const minX = Math.max(0, Math.floor(Math.min(a.u, b.u, c.u)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(a.u, b.u, c.u)));
    const minY = Math.max(0, Math.floor(Math.min(a.v, b.v, c.v)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(a.v, b.v, c.v)));
    if (minX > maxX || minY > maxY) return;
    const area = (b.u - a.u) * (c.v - a.v) - (b.v - a.v) * (c.u - a.u);
    if (Math.abs(area) < 1e-8) return;
    for (let py = minY; py <= maxY; py += 1) {
      for (let px = minX; px <= maxX; px += 1) {
        const w0 = ((b.u - a.u) * (py + 0.5 - a.v) - (b.v - a.v) * (px + 0.5 - a.u)) / area;
        const w1 = ((px + 0.5 - a.u) * (c.v - a.v) - (py + 0.5 - a.v) * (c.u - a.u)) / area;
        if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
        const z = a.z + w1 * (b.z - a.z) + w0 * (c.z - a.z);
        const key = py * width + px;
        if (z < depth[key]) depth[key] = z;
      }
    }
  };
  const stride = Math.max(1, Math.round(Math.min(cols, rows) / 220));
  for (let row = 0; row < rows - stride; row += stride) {
    for (let col = 0; col < cols - stride; col += stride) {
      const a = project(col, row);
      const b = project(col + stride, row);
      const c = project(col, row + stride);
      const d = project(col + stride, row + stride);
      if (a && c && b) fill(a, c, b);
      if (b && c && d) fill(b, c, d);
    }
  }
  return depth;
}

/**
 * Bakes a photographic orthophoto onto the DSM by reprojecting every undistorted
 * source frame through its solved pose. Texels with no camera coverage keep the
 * DSM albedo rather than inventing colour.
 */
export async function bakeOrthophoto({
  workDir,
  grid,
  albedo,
  rotation,
  origin,
  maxEdge = 1536,
} = {}) {
  if (!workDir || !grid) return { png: encodePng(albedo, grid.cols, grid.rows), width: grid.cols, height: grid.rows, coverage: 0, cameras: 0 };
  const views = await readUndistortedViews(workDir);
  if (!views.length) return { png: encodePng(albedo, grid.cols, grid.rows), width: grid.cols, height: grid.rows, coverage: 0, cameras: 0 };

  const cameras = views.map((view) => ({
    ...view,
    center: rotatePoint(view.center, rotation, origin),
    rightAxis: rotateVec(view.rightAxis, rotation),
    downAxis: rotateVec(view.downAxis, rotation),
    viewAxis: rotateVec(view.viewAxis, rotation),
  }));

  const { cols, rows, box, mask, height } = grid;
  const spanX = Math.max(1e-6, box.max[0] - box.min[0]);
  const spanZ = Math.max(1e-6, box.max[2] - box.min[2]);
  const aspect = spanX / spanZ;
  const texW = aspect >= 1 ? maxEdge : Math.max(256, Math.round(maxEdge * aspect));
  const texH = aspect >= 1 ? Math.max(256, Math.round(maxEdge / aspect)) : maxEdge;
  const sum = new Float32Array(texW * texH * 3);
  const weight = new Float32Array(texW * texH);
  const lumas = [];

  const colAt = (x) => (x / Math.max(1, texW - 1)) * (cols - 1);
  const rowAt = (y) => (1 - y / Math.max(1, texH - 1)) * (rows - 1);
  const active = [];
  for (let ty = 0; ty < texH; ty += 1) {
    const gridRow = rowAt(ty);
    const r0 = Math.max(0, Math.min(rows - 1, Math.round(gridRow)));
    for (let tx = 0; tx < texW; tx += 1) {
      const gridCol = colAt(tx);
      const c0 = Math.max(0, Math.min(cols - 1, Math.round(gridCol)));
      const cell = r0 * cols + c0;
      if (!mask[cell] || Number.isNaN(height[cell])) continue;
      active.push({
        key: ty * texW + tx,
        world: [
          box.min[0] + (gridCol / Math.max(1, cols - 1)) * spanX,
          height[cell],
          box.min[2] + (gridRow / Math.max(1, rows - 1)) * spanZ,
        ],
      });
    }
  }

  for (const camera of cameras) {
    const encoded = await readFile(camera.path);
    const decoded = jpeg.decode(encoded, { useTArray: true, formatAsRGBA: false });
    const imgW = decoded.width;
    const imgH = decoded.height;
    const rgb = decoded.data;
    let frameLuma = 0;
    let frameCount = 0;
    const depthW = Math.max(160, Math.round(imgW / 2));
    const depthH = Math.max(90, Math.round(imgH / 2));
    const depth = rasterizeDepth(grid, camera, depthW, depthH);
    const fx = camera.fx * (imgW / camera.width);
    const fy = camera.fy * (imgH / camera.height);
    const cx = camera.cx * (imgW / camera.width);
    const cy = camera.cy * (imgH / camera.height);

    for (const texel of active) {
      const world = texel.world;
      const dx = world[0] - camera.center[0];
      const dy = world[1] - camera.center[1];
      const dz = world[2] - camera.center[2];
      const z = dx * camera.viewAxis[0] + dy * camera.viewAxis[1] + dz * camera.viewAxis[2];
      if (z < 0.05) continue;
      const x = dx * camera.rightAxis[0] + dy * camera.rightAxis[1] + dz * camera.rightAxis[2];
      const y = dx * camera.downAxis[0] + dy * camera.downAxis[1] + dz * camera.downAxis[2];
      const u = fx * (x / z) + cx;
      const v = fy * (y / z) + cy;
      if (u < 1 || v < 1 || u >= imgW - 2 || v >= imgH - 2) continue;
      const du = (u / imgW) * depthW;
      const dv = (v / imgH) * depthH;
      const di = Math.min(depthH - 1, Math.max(0, Math.round(dv))) * depthW + Math.min(depthW - 1, Math.max(0, Math.round(du)));
      if (z > depth[di] * 1.035 + 0.15) continue;
      const dist = Math.hypot(dx, dy, dz);
      const cosine = Math.max(0, z / dist);
      if (cosine < 0.18) continue;
      const vignette = 1 - Math.min(1, ((u / imgW - 0.5) ** 2 + (v / imgH - 0.5) ** 2) * 3.2);
      const w = (cosine ** 2) * (0.35 + 0.65 * vignette) / (1 + dist * 0.002);
      if (w < 1e-4) continue;
      const sample = sampleBilinear(rgb, imgW, imgH, u, v);
      if (sample[0] > 252 && sample[1] > 252 && sample[2] > 252) continue;
      const key = texel.key;
      sum[key * 3] += sample[0] * w;
      sum[key * 3 + 1] += sample[1] * w;
      sum[key * 3 + 2] += sample[2] * w;
      weight[key] += w;
      frameLuma += 0.299 * sample[0] + 0.587 * sample[1] + 0.114 * sample[2];
      frameCount += 1;
    }
    if (frameCount > 200) lumas.push(frameLuma / frameCount);
  }

  const globalLuma = lumas.length ? lumas.reduce((a, b) => a + b, 0) / lumas.length : 128;
  const gain = Number.isFinite(globalLuma) && globalLuma > 8 ? Math.max(0.85, Math.min(1.35, 132 / globalLuma)) : 1;
  const pixels = Buffer.alloc(texW * texH * 3);
  let covered = 0;
  let visible = 0;
  for (let ty = 0; ty < texH; ty += 1) {
    const gridRow = Math.max(0, Math.min(rows - 1, Math.round(rowAt(ty))));
    for (let tx = 0; tx < texW; tx += 1) {
      const gridCol = Math.max(0, Math.min(cols - 1, Math.round(colAt(tx))));
      const cell = gridRow * cols + gridCol;
      const key = ty * texW + tx;
      const onTerrain = mask[cell] && !Number.isNaN(height[cell]);
      if (onTerrain) visible += 1;
      if (onTerrain && weight[key] > 1e-4) {
        covered += 1;
        pixels[key * 3] = Math.max(0, Math.min(255, Math.round((sum[key * 3] / weight[key]) * gain)));
        pixels[key * 3 + 1] = Math.max(0, Math.min(255, Math.round((sum[key * 3 + 1] / weight[key]) * gain)));
        pixels[key * 3 + 2] = Math.max(0, Math.min(255, Math.round((sum[key * 3 + 2] / weight[key]) * gain)));
      } else if (onTerrain && albedo) {
        pixels[key * 3] = albedo[cell * 3] || 110;
        pixels[key * 3 + 1] = albedo[cell * 3 + 1] || 118;
        pixels[key * 3 + 2] = albedo[cell * 3 + 2] || 104;
      } else {
        pixels[key * 3] = 18;
        pixels[key * 3 + 1] = 26;
        pixels[key * 3 + 2] = 32;
      }
    }
  }

  return {
    png: encodePng(pixels, texW, texH),
    width: texW,
    height: texH,
    coverage: visible ? covered / visible : 0,
    cameras: cameras.length,
  };
}
