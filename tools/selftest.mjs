import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { killTree, queueExclusive, normalizeAltitude, engineAvailable, commands, parseEngineLine, createProgressTracker, createLineProgress } from '../lib/reconstruct.mjs';
import { parseNvidiaSmi, resetTelemetry } from '../lib/telemetry.mjs';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const order = [];
const slow = queueExclusive(async () => {
  order.push('a:start');
  await new Promise((r) => setTimeout(r, 300));
  order.push('a:end');
});
const fast = queueExclusive(async () => {
  order.push('b:start');
  order.push('b:end');
});
await Promise.all([slow, fast]);
check(
  'queueExclusive serialises GPU work',
  order.join(',') === 'a:start,a:end,b:start,b:end',
  order.join(','),
);

const failing = queueExclusive(async () => { throw new Error('boom'); }).catch(() => 'handled');
const after = queueExclusive(async () => 'ran');
check('queue survives a failing task', (await failing) === 'handled' && (await after) === 'ran');

// A rejected job must not leave its engine running.
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true });
await new Promise((r) => setTimeout(r, 400));
const pid = child.pid;
killTree(child);
await new Promise((r) => setTimeout(r, 1500));
const stillAlive = await new Promise((r) => {
  try {
    process.kill(pid, 0);
    r(true);
  } catch {
    r(false);
  }
});
check('killTree terminates a spawned engine', !stillAlive, `pid ${pid}`);

check('altitude rejects zero', normalizeAltitude(0) === 82);
check('altitude rejects text', normalizeAltitude('abc') === 82);
check('altitude clamps absurd values', normalizeAltitude(99999) === 2000);
check('altitude keeps sane values', normalizeAltitude(120) === 120);

const sparse = resolve('runtime/0c7f4613-8279-4211-a678-f131d0875cd7/sparse/0/images.bin');
if (existsSync(sparse)) {
  const handle = openSync(sparse, 'r');
  const header = Buffer.alloc(8);
  readSync(handle, header, 0, 8, 0);
  closeSync(handle);
  const count = Number(header.readBigUInt64LE(0));
  check('registered image count reads the real model', count === 90, `${count} images`);
}

check('ffmpeg binary resolves', existsSync(commands.ffmpeg), commands.ffmpeg);
check('colmap binary resolves', existsSync(commands.colmap), commands.colmap);
check('engineAvailable agrees', await engineAvailable(commands.colmap));

const viewLine = parseEngineLine('patch_match.cc:419] === Processing view 45 / 90 for frame_000045.jpg ===');
check('parse dense-stereo progress', viewLine?.done === 45 && viewLine?.total === 90, JSON.stringify(viewLine));
const fuseLine = parseEngineLine('fusion.cc:283] Fusing image [43/90] with index 45');
check('parse fusion progress', fuseLine?.kind === 'fuse' && fuseLine.done === 43);
const frameLine = parseEngineLine('frame=   90 fps=27.4 q=2.0 size=N/A time=00:00:09.00 bitrate=N/A speed=27.4x');
check('parse ffmpeg progress', frameLine?.kind === 'frame' && frameLine.done === 90);

const stereo = createLineProgress({ total: 90, passes: 2 });
stereo.feed('=== Processing view 90 / 90 ===');
check('first stereo pass is half the stage', Math.abs(stereo.fraction - 0.5) < 0.01, String(stereo.fraction));
stereo.feed('=== Processing view 1 / 90 ===');
check('view reset starts pass two', stereo.fraction > 0.5 && stereo.fraction < 0.6, String(stereo.fraction));

let clock = 0;
const job = { progress: 0 };
const tracker = createProgressTracker(job, undefined, () => clock);
tracker.start('extract');
clock = 4000;
tracker.fraction(1);
tracker.complete('extract');
check('tracker reports extract complete', job.stages?.[0]?.status === 'complete' && job.progress > 0);
tracker.start('stereo');
clock = 8000;
tracker.fraction(0.5, { kind: 'view', done: 45, total: 90, pass: 1, passes: 2 });
check('ETA appears after enough elapsed weight', job.etaMs === null || Number.isFinite(job.etaMs));
tracker.finish();
check('tracker finish is 100%', job.progress === 100 && job.stage === 'Complete');

resetTelemetry();
const parsedGpu = parseNvidiaSmi('12, 1024, 8192, 61');
check('nvidia-smi parser', parsedGpu?.utilisationPercent === 12 && parsedGpu.memoryTotalMb === 8192);
check('nvidia-smi parser rejects junk', parseNvidiaSmi('nope') === null);

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
