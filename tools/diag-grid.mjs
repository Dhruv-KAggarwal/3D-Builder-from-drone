import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parsePly } from '../lib/ply.mjs';
import { readCameraPoses, gravityUpFromPoses } from '../lib/colmap.mjs';
import { trimFootprint } from '../lib/terrain.mjs';
import {
  applyRotation, boundsOf, centroid, compactCloud, densityFilter, rotationToYUp,
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
const box = boundsOf(trimmed.positions);
const relief = box.max[1] - box.min[1];
console.log(`points=${trimmed.positions.length / 3} relief=${relief.toFixed(3)}`);

for (const longAxis of [320, 480, 760]) {
  const spanX = box.max[0] - box.min[0];
  const spanZ = box.max[2] - box.min[2];
  const cols = spanX >= spanZ ? longAxis : Math.round(longAxis * (spanX / spanZ));
  const rows = spanX >= spanZ ? Math.round(longAxis * (spanZ / spanX)) : longAxis;
  const counts = new Uint32Array(cols * rows);
  const sumY = new Float64Array(cols * rows);
  for (let i = 0; i < trimmed.positions.length / 3; i += 1) {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(((trimmed.positions[i * 3] - box.min[0]) / spanX) * (cols - 1))));
    const cz = Math.min(rows - 1, Math.max(0, Math.floor(((trimmed.positions[i * 3 + 2] - box.min[2]) / spanZ) * (rows - 1))));
    const cell = cz * cols + cx;
    counts[cell] += 1;
    sumY[cell] += trimmed.positions[i * 3 + 1];
  }
  const occ = [...counts].filter((c) => c > 0).sort((a, b) => a - b);
  const p = (f) => occ[Math.floor(f * (occ.length - 1))];
  console.log(`\ngrid ${cols}x${rows}  occupied=${occ.length}/${cols * rows} (${(100 * occ.length / (cols * rows)).toFixed(0)}%)`);
  console.log(`  occupancy p10=${p(0.1)} p25=${p(0.25)} p50=${p(0.5)} p75=${p(0.75)} p90=${p(0.9)}`);
  for (const minC of [1, 3, 6, 12, 25]) {
    let rough = 0;
    let kept = 0;
    for (let y = 1; y < rows - 1; y += 1) {
      for (let x = 1; x < cols - 1; x += 1) {
        const i = y * cols + x;
        if (counts[i] < minC) continue;
        kept += 1;
        const h = sumY[i] / counts[i];
        const nb = [];
        for (let d = 0; d < 4; d += 1) {
          const ni = i + [1, -1, cols, -cols][d];
          if (counts[ni] >= minC) nb.push(sumY[ni] / counts[ni]);
        }
        if (nb.length < 2) continue;
        nb.sort((a, b) => a - b);
        if (Math.abs(h - nb[Math.floor(nb.length / 2)]) > relief * 0.05) rough += 1;
      }
    }
    console.log(`  minCount=${String(minC).padStart(2)}  cells=${String(kept).padStart(7)}  rough(>5% relief)=${(100 * rough / Math.max(1, kept)).toFixed(1)}%`);
  }
}
