import { mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { reconstruct, exportExistingJob, normalizeFrames, normalizeQuality, normalizeThreads } from './lib/reconstruct.mjs';

const args = process.argv.slice(2);
const quality = normalizeQuality(
  args.includes('--detailed') || args.includes('--studio') ? 'detailed'
    : args.includes('--balanced') ? 'balanced'
      : 'fast',
);
const altitude = Number((args.find((arg) => arg.startsWith('--altitude=')) || '').split('=')[1] || 82);
const frames = normalizeFrames((args.find((arg) => arg.startsWith('--frames=')) || '').split('=')[1]);
const threadArg = args.find((arg) => arg.startsWith('--threads='));
const threads = threadArg ? normalizeThreads(threadArg.split('=')[1]) : null;
const reuse = args.find((arg) => arg.startsWith('--reuse='))?.split('=')[1];
const full = args.includes('--full');
const input = args.find((arg) => !arg.startsWith('--'));

if (!input && !reuse) {
  console.error('Usage: node reconstruct-cli.mjs <video.mp4> [--fast|--balanced|--detailed] [--frames=64] [--threads=8] [--altitude=82]');
  console.error('   or: node reconstruct-cli.mjs --reuse=runtime/<job-id> [--view|--full] [--altitude=82]');
  process.exit(1);
}

if (reuse) {
  const result = await exportExistingJob(resolve(reuse), altitude, basename(input || reuse), full ? 'full' : 'view');
  console.log(JSON.stringify(result.metadata, null, 2));
  console.log(`Wrote products to ${result.files.glb}`);
  process.exit(0);
}

if (!existsSync(input)) {
  console.error(`Video not found: ${input}`);
  process.exit(1);
}

const id = randomUUID();
const work = resolve('runtime', id);
await mkdir(work, { recursive: true });
const dest = join(work, `input${input.toLowerCase().endsWith('.mov') ? '.mov' : '.mp4'}`);
await copyFile(input, dest);
const job = {
  id,
  work,
  input: dest,
  fileName: basename(input),
  quality,
  frames,
  threads,
  altitude,
  progress: 0,
  stage: 'Queued',
  status: 'processing',
};
const timer = setInterval(() => {
  process.stdout.write(`\r${String(job.progress).padStart(3, ' ')}%  ${job.stage || ''}`.padEnd(80, ' '));
}, 800);
try {
  await reconstruct(job);
  clearInterval(timer);
  console.log(`\nComplete: ${job.result.model}`);
  console.log(JSON.stringify(job.metrics, null, 2));
} catch (error) {
  clearInterval(timer);
  console.error(`\nFailed: ${error.message}`);
  process.exit(1);
}
