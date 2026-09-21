import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parsePly } from '../lib/ply.mjs';
import { encodePng, decodePng } from '../lib/png.mjs';
import {
  applyRotation, boundsOf, centroid, computeNormals, rotationToYUp,
} from '../lib/geometry.mjs';
import { gravityUpFromPoses, readCameraPoses } from '../lib/colmap.mjs';

const args = process.argv.slice(2);
const input = resolve(args.find((a) => !a.startsWith('--')) || 'output/latest/terrain.ply');
const out = resolve((args.find((a) => a.startsWith('--out=')) || '--out=output/preview.png').split('=')[1]);
const width = Number((args.find((a) => a.startsWith('--w=')) || '--w=900').split('=')[1]);
const height = Number((args.find((a) => a.startsWith('--h=')) || '--h=600').split('=')[1]);
const azimuth = Number((args.find((a) => a.startsWith('--az=')) || '--az=35').split('=')[1]) * Math.PI / 180;
const elevation = Number((args.find((a) => a.startsWith('--el=')) || '--el=28').split('=')[1]) * Math.PI / 180;
const texArg = args.find((a) => a.startsWith('--tex='));
const texture = texArg ? decodePng(await readFile(resolve(texArg.split('=')[1]))) : null;

const mesh = parsePly(await readFile(input));
const pointMode = !mesh.indices?.length;

// Raw COLMAP output sits in an arbitrary frame, so candidate meshes have to be
// rotated into gravity before they can be compared side by side.
const alignArg = args.find((a) => a.startsWith('--align='));
if (alignArg) {
  const work = resolve(alignArg.split('=')[1]);
  const poses = await readCameraPoses(work);
  const up = gravityUpFromPoses(poses);
  if (!up) throw new Error(`No camera poses found under ${work}`);
  mesh.positions = applyRotation(mesh.positions, rotationToYUp(up), centroid(mesh.positions));
}

const box = boundsOf(mesh.positions);
const center = [
  (box.min[0] + box.max[0]) / 2,
  (box.min[1] + box.max[1]) / 2,
  (box.min[2] + box.max[2]) / 2,
];
const radius = Math.max(
  box.max[0] - box.min[0],
  box.max[1] - box.min[1],
  box.max[2] - box.min[2],
) * 0.5 || 1;

const dist = radius * 2.6;
const eye = [
  center[0] + dist * Math.cos(elevation) * Math.sin(azimuth),
  center[1] + dist * Math.sin(elevation),
  center[2] + dist * Math.cos(elevation) * Math.cos(azimuth),
];

function normalize(v) {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

const forward = normalize(sub(center, eye));
const right = normalize(cross(forward, [0, 1, 0]));
const up = cross(right, forward);
const focal = (height * 0.5) / Math.tan((42 * Math.PI / 180) / 2);

const vertexCount = mesh.positions.length / 3;
const projected = new Float32Array(vertexCount * 3);
for (let i = 0; i < vertexCount; i += 1) {
  const p = sub([mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]], eye);
  const cx = dot(p, right);
  const cy = dot(p, up);
  const cz = dot(p, forward);
  projected[i * 3] = cz > 1e-4 ? width / 2 + (focal * cx) / cz : Number.NaN;
  projected[i * 3 + 1] = cz > 1e-4 ? height / 2 - (focal * cy) / cz : Number.NaN;
  projected[i * 3 + 2] = cz;
}

const normals = pointMode
  ? new Float32Array(mesh.positions.length)
  : computeNormals(mesh.positions, mesh.indices);
const sun = normalize([0.45, 0.8, 0.4]);
const depth = new Float32Array(width * height).fill(Infinity);
const pixels = Buffer.alloc(width * height * 3);
for (let i = 0; i < pixels.length; i += 3) {
  const t = Math.floor(i / 3 / width) / height;
  pixels[i] = Math.round(120 + 60 * (1 - t));
  pixels[i + 1] = Math.round(150 + 50 * (1 - t));
  pixels[i + 2] = Math.round(180 + 40 * (1 - t));
}

let drawn = 0;
if (pointMode) {
  // Circular splats whose radius shrinks with distance, so the render matches
  // what a size-attenuated THREE.Points material shows in the browser.
  const world = Number((args.find((a) => a.startsWith('--psize=')) || '--psize=0').split('=')[1])
    || radius * 0.004;
  const cap = Number((args.find((a) => a.startsWith('--splat=')) || '--splat=4').split('=')[1]);
  for (let i = 0; i < vertexCount; i += 1) {
    const sx = projected[i * 3];
    const sy = projected[i * 3 + 1];
    const sz = projected[i * 3 + 2];
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
    const r = Math.max(0.5, Math.min(cap, (focal * world) / sz));
    const r2 = r * r;
    const span = Math.ceil(r);
    for (let dy = -span; dy <= span; dy += 1) {
      for (let dx = -span; dx <= span; dx += 1) {
        if (dx * dx + dy * dy > r2) continue;
        const x = Math.round(sx) + dx;
        const y = Math.round(sy) + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const key = y * width + x;
        if (sz >= depth[key]) continue;
        depth[key] = sz;
        // Shade the splat edge slightly so overlapping points read as surface
        // rather than as flat confetti.
        const falloff = 1 - 0.28 * ((dx * dx + dy * dy) / Math.max(r2, 1e-6));
        pixels[key * 3] = Math.round((mesh.colors ? mesh.colors[i * 3] : 180) * falloff);
        pixels[key * 3 + 1] = Math.round((mesh.colors ? mesh.colors[i * 3 + 1] : 180) * falloff);
        pixels[key * 3 + 2] = Math.round((mesh.colors ? mesh.colors[i * 3 + 2] : 180) * falloff);
      }
    }
    drawn += 1;
  }
  await writeFile(out, encodePng(pixels, width, height));
  console.log(`Splatted ${drawn} of ${vertexCount} points to ${out}`);
  console.log(`extent X=${(box.max[0] - box.min[0]).toFixed(1)} Y=${(box.max[1] - box.min[1]).toFixed(1)} Z=${(box.max[2] - box.min[2]).toFixed(1)}`);
  process.exit(0);
}
for (let f = 0; f < mesh.indices.length; f += 3) {
  const ia = mesh.indices[f];
  const ib = mesh.indices[f + 1];
  const ic = mesh.indices[f + 2];
  const ax = projected[ia * 3];
  const ay = projected[ia * 3 + 1];
  const az = projected[ia * 3 + 2];
  const bx = projected[ib * 3];
  const by = projected[ib * 3 + 1];
  const bz = projected[ib * 3 + 2];
  const cx = projected[ic * 3];
  const cy = projected[ic * 3 + 1];
  const cz = projected[ic * 3 + 2];
  if (!Number.isFinite(ax) || !Number.isFinite(bx) || !Number.isFinite(cx)) continue;
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
  if (minX > maxX || minY > maxY) continue;
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) < 1e-9) continue;
  let shade = 0;
  for (const idx of [ia, ib, ic]) {
    shade += Math.abs(dot([normals[idx * 3], normals[idx * 3 + 1], normals[idx * 3 + 2]], sun));
  }
  shade = 0.48 + 0.52 * (shade / 3);
  const cr0 = mesh.colors ? mesh.colors[ia * 3] : 150;
  const cg0 = mesh.colors ? mesh.colors[ia * 3 + 1] : 150;
  const cb0 = mesh.colors ? mesh.colors[ia * 3 + 2] : 150;
  const cr1 = mesh.colors ? mesh.colors[ib * 3] : 150;
  const cg1 = mesh.colors ? mesh.colors[ib * 3 + 1] : 150;
  const cb1 = mesh.colors ? mesh.colors[ib * 3 + 2] : 150;
  const cr2 = mesh.colors ? mesh.colors[ic * 3] : 150;
  const cg2 = mesh.colors ? mesh.colors[ic * 3 + 1] : 150;
  const cb2 = mesh.colors ? mesh.colors[ic * 3 + 2] : 150;
  const spanX = Math.max(1e-6, box.max[0] - box.min[0]);
  const spanZ = Math.max(1e-6, box.max[2] - box.min[2]);
  drawn += 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / area;
      const w1 = ((px - ax) * (cy - ay) - (py - ay) * (cx - ax)) / area;
      if (w0 < 0 || w1 < 0 || w0 + w1 > 1) continue;
      const z = az + w1 * (bz - az) + w0 * (cz - az);
      const key = y * width + x;
      if (z >= depth[key]) continue;
      depth[key] = z;
      const wA = 1 - w0 - w1;
      let cr = wA * cr0 + w1 * cr1 + w0 * cr2;
      let cg = wA * cg0 + w1 * cg1 + w0 * cg2;
      let cb = wA * cb0 + w1 * cb1 + w0 * cb2;
      if (texture) {
        const wx = wA * mesh.positions[ia * 3] + w1 * mesh.positions[ib * 3] + w0 * mesh.positions[ic * 3];
        const wz = wA * mesh.positions[ia * 3 + 2] + w1 * mesh.positions[ib * 3 + 2] + w0 * mesh.positions[ic * 3 + 2];
        const uu = Math.max(0, Math.min(1, (wx - box.min[0]) / spanX));
        const vv = Math.max(0, Math.min(1, 1 - (wz - box.min[2]) / spanZ));
        const tx = Math.min(texture.width - 1, Math.floor(uu * (texture.width - 1)));
        const ty = Math.min(texture.height - 1, Math.floor(vv * (texture.height - 1)));
        const ti = (ty * texture.width + tx) * 3;
        cr = texture.data[ti];
        cg = texture.data[ti + 1];
        cb = texture.data[ti + 2];
      }
      pixels[key * 3] = Math.min(255, Math.round(cr * shade));
      pixels[key * 3 + 1] = Math.min(255, Math.round(cg * shade));
      pixels[key * 3 + 2] = Math.min(255, Math.round(cb * shade));
    }
  }
}

await writeFile(out, encodePng(pixels, width, height));
console.log(`Rendered ${drawn} faces of ${mesh.indices.length / 3} to ${out}`);
console.log(`extent X=${(box.max[0] - box.min[0]).toFixed(1)} Y=${(box.max[1] - box.min[1]).toFixed(1)} Z=${(box.max[2] - box.min[2]).toFixed(1)}`);
