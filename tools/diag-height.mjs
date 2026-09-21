import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parsePly } from '../lib/ply.mjs';
import { encodePng } from '../lib/png.mjs';
import { readCameraPoses, gravityUpFromPoses } from '../lib/colmap.mjs';
import { buildTerrain, trimFootprint } from '../lib/terrain.mjs';
import {
  applyRotation, centroid, compactCloud, densityFilter, rotationToYUp,
} from '../lib/geometry.mjs';

const work = resolve(process.argv[2] || 'runtime/0c7f4613-8279-4211-a678-f131d0875cd7');
const parsed = parsePly(await readFile(resolve(work, 'dense/fused.ply')));
let cloud = compactCloud(parsed.positions, parsed.colors, parsed.normals);
const den = densityFilter(cloud.positions, cloud.colors, 96, 3);
cloud = { positions: den.positions, colors: den.colors };

const poses = await readCameraPoses(work);
const rotation = rotationToYUp(gravityUpFromPoses(poses));
const aligned = applyRotation(cloud.positions, rotation, centroid(cloud.positions));
const trimmed = trimFootprint(aligned, cloud.colors);
const terrain = buildTerrain(trimmed.positions, trimmed.colors, {});
const { cols, rows, height, mask } = terrain.grid;

let lo = Infinity;
let hi = -Infinity;
for (let i = 0; i < height.length; i += 1) {
  if (!mask[i] || Number.isNaN(height[i])) continue;
  if (height[i] < lo) lo = height[i];
  if (height[i] > hi) hi = height[i];
}
const span = Math.max(1e-6, hi - lo);
const img = Buffer.alloc(cols * rows * 3);
for (let i = 0; i < cols * rows; i += 1) {
  if (!mask[i] || Number.isNaN(height[i])) {
    img[i * 3] = 20;
    img[i * 3 + 1] = 30;
    img[i * 3 + 2] = 60;
    continue;
  }
  const v = Math.round(255 * ((height[i] - lo) / span));
  img[i * 3] = v;
  img[i * 3 + 1] = v;
  img[i * 3 + 2] = v;
}
await writeFile(resolve('output/diag-height.png'), encodePng(img, cols, rows));

// Vertical slice through the middle row, printed as text so spikes are countable.
const row = Math.floor(rows / 2);
const slice = [];
for (let x = 0; x < cols; x += Math.max(1, Math.floor(cols / 60))) {
  const i = row * cols + x;
  slice.push(mask[i] && !Number.isNaN(height[i]) ? ((height[i] - lo) / span).toFixed(2) : ' .  ');
}
console.log(`grid ${cols}x${rows} heightRange=${lo.toFixed(2)}..${hi.toFixed(2)}`);
console.log(`mid-row profile:\n${slice.join(' ')}`);

let jumps = 0;
let measured = 0;
for (let y = 1; y < rows - 1; y += 1) {
  for (let x = 1; x < cols - 1; x += 1) {
    const i = y * cols + x;
    if (!mask[i] || Number.isNaN(height[i])) continue;
    measured += 1;
    const r = height[i + 1];
    if (!Number.isNaN(r) && Math.abs(height[i] - r) > span * 0.08) jumps += 1;
  }
}
console.log(`cells=${measured} neighbourJumps>8%span=${jumps} (${(100 * jumps / measured).toFixed(1)}%)`);
