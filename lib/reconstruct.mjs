import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readdir, writeFile, copyFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { buildProducts } from './export3d.mjs';
import { classifyHardware, hardwareFromTelemetry } from './hardware.mjs';
import { sampleTelemetry } from './telemetry.mjs';

export const commands = {
  ffmpeg: process.env.FFMPEG_PATH || resolve('engines/ffmpeg/bin/ffmpeg.exe'),
  ffprobe: process.env.FFPROBE_PATH || resolve('engines/ffmpeg/bin/ffprobe.exe'),
  colmap: process.env.COLMAP_PATH || resolve('engines/colmap/bin/colmap.exe'),
  openmvs: process.env.OPENMVS_PATH || resolve('engines/openmvs'),
};

/** Every engine process currently running, so none can outlive this server. */
const activeChildren = new Set();

/**
 * Terminates an engine and everything it spawned.
 *
 * `child.kill()` is not enough on Windows: it signals only the direct child, so
 * a COLMAP run detaches and keeps holding the GPU after its owner has gone.
 * Orphans like that starve the next job and silently corrupt a shared dense
 * workspace, so the whole tree has to go.
 */
export function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

export function terminateAllEngines() {
  for (const child of activeChildren) killTree(child);
  activeChildren.clear();
}

/**
 * Recognises the sub-progress each engine prints.
 *
 * Without this the bar sits frozen for the eight minutes that dense stereo
 * takes. Formats are taken from real `engine.log` output rather than guessed:
 *
 *   ffmpeg              frame=   90 fps=0.0 q=2.0 ... speed=27.4x
 *   feature_extractor   feature_extraction.cc:270] Processed file [77/90]
 *   sequential_matcher  pairing.cc:560] Processing image [35/90]
 *   mapper              incremental_pipeline.cc:620] Registering image #56 (num_reg_frames=55)
 *   patch_match_stereo  patch_match.cc:419] === Processing view 89 / 90 for frame_000089.jpg ===
 *   stereo_fusion       fusion.cc:283] Fusing image [43/90] with index 45
 */
export function parseEngineLine(line) {
  const text = String(line);
  let match = text.match(/=== Processing view (\d+) \/ (\d+)/);
  if (match) return { kind: 'view', done: Number(match[1]), total: Number(match[2]) };

  match = text.match(/Fusing image \[(\d+)\/(\d+)\]/);
  if (match) return { kind: 'fuse', done: Number(match[1]), total: Number(match[2]) };

  match = text.match(/Processed file \[(\d+)\/(\d+)\]/);
  if (match) return { kind: 'file', done: Number(match[1]), total: Number(match[2]) };

  match = text.match(/Processing image \[(\d+)\/(\d+)\]/);
  if (match) return { kind: 'image', done: Number(match[1]), total: Number(match[2]) };

  match = text.match(/num_reg_frames=(\d+)/);
  if (match) return { kind: 'register', done: Number(match[1]) + 1, total: null };

  match = text.match(/Registering image #(\d+)/);
  if (match) return { kind: 'register', done: Number(match[1]), total: null };

  match = text.match(/^frame=\s*(\d+)/m) || text.match(/\bframe=\s*(\d+)/);
  if (match) return { kind: 'frame', done: Number(match[1]), total: null };

  return null;
}

/**
 * Turns a stream of engine lines into a 0..1 fraction for one stage.
 *
 * `passes` matters: with `geom_consistency 1` patch_match_stereo walks every
 * view twice, so counting a single 1..N sweep as "done" would park the bar at
 * 100% for half the stage. A view index that goes backwards means a new pass.
 */
export function createLineProgress({ total = null, passes = 1 } = {}) {
  let knownTotal = total && total > 0 ? total : null;
  let pass = 0;
  let previous = 0;
  let best = 0;
  return {
    get fraction() { return best; },
    feed(line) {
      const parsed = parseEngineLine(line);
      if (!parsed) return null;
      if (parsed.total && parsed.total > 0) knownTotal = parsed.total;
      if (!knownTotal) return null;
      const done = Math.min(parsed.done, knownTotal);
      if (done < previous) pass = Math.min(pass + 1, passes - 1);
      previous = done;
      const fraction = (pass + done / knownTotal) / passes;
      best = Math.min(1, Math.max(best, fraction));
      return { ...parsed, total: knownTotal, pass: pass + 1, passes, fraction: best };
    },
  };
}

export function run(command, args, cwd, job, label, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const tracker = job.tracker || null;
    // The tracker owns `job.stage` when there is one; the CLI has no tracker.
    if (tracker) tracker.start(options.stage, label);
    else job.stage = label;
    const lineProgress = createLineProgress({ total: options.total, passes: options.passes || 1 });
    let pending = '';
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    activeChildren.add(child);
    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      if (error) rejectRun(error);
      else resolveRun();
    };

    // A cancelled or timed-out job must take its engine down with it rather
    // than leaving it to compete with whatever runs next.
    const onCancel = () => {
      killTree(child);
      job.cancelHooks?.delete(onCancel);
      finish(new Error(`${label} was cancelled.`));
    };
    job.cancelHooks?.add(onCancel);

    const timeoutMs = command.toLowerCase().includes('colmap') ? 50 * 60 * 1000 : 30 * 60 * 1000;
    const timeout = setTimeout(() => {
      killTree(child);
      job.cancelHooks?.delete(onCancel);
      finish(new Error(`${label} exceeded the processing timeout.`));
    }, timeoutMs);

    const collect = (chunk) => {
      const text = chunk.toString();
      stderr += text;
      if (stderr.length > 1_500_000) stderr = stderr.slice(-800_000);
      // FFmpeg rewrites its status line with \r and never emits \n, so both
      // terminators have to end a line or the bar would never move during
      // frame extraction.
      pending += text;
      const parts = pending.split(/[\r\n]+/);
      pending = parts.pop() ?? '';
      if (pending.length > 4096) pending = pending.slice(-2048);
      for (const part of parts) {
        const update = lineProgress.feed(part);
        if (update && tracker) tracker.fraction(update.fraction, update);
      }
    };
    child.stderr?.on('data', collect);
    child.stdout?.on('data', collect);
    child.on('error', (error) => {
      clearTimeout(timeout);
      job.cancelHooks?.delete(onCancel);
      finish(new Error(`${command} is unavailable: ${error.message}`));
    });
    child.on('close', async (code) => {
      clearTimeout(timeout);
      job.cancelHooks?.delete(onCancel);
      try {
        await writeFile(join(cwd, 'engine.log'), `\n--- ${label} (${new Date().toISOString()}) ---\n${stderr.slice(-8000)}\n`, { flag: 'a' });
      } catch {
        // logging must never mask the real result
      }
      finish(code === 0 ? null : new Error(`${label} failed with code ${code}: ${stderr.slice(-1200)}`));
    });
  });
}

let gpuChain = Promise.resolve();

/**
 * Serialises GPU work. Two dense runs sharing one card thrash its memory and,
 * worse, interleave writes into the same depth-map directory, so a second job
 * can quietly poison the first one's output.
 */
export function queueExclusive(task) {
  const result = gpuChain.then(task, task);
  gpuChain = result.then(() => undefined, () => undefined);
  return result;
}

export async function engineAvailable(command) {
  if (command.includes('/') || command.includes('\\')) return existsSync(command);
  return new Promise((resolveAvailable) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolveAvailable(value);
    };
    const probe = spawn(command, ['-h'], { windowsHide: true, stdio: 'ignore' });
    const guard = setTimeout(() => {
      killTree(probe);
      done(false);
    }, 10_000);
    probe.on('error', () => {
      clearTimeout(guard);
      done(false);
    });
    probe.on('close', (code) => {
      clearTimeout(guard);
      done(code === 0 || code === 1);
    });
  });
}

const PROBE_FALLBACK = { duration: 10, frames: 240, width: 1280, height: 720, reliable: false };

/**
 * Reads the clip's real duration.
 *
 * The frame sampling rate is derived from this, so guessing here is dangerous:
 * silently assuming ten seconds for a ten-minute flight samples one frame per
 * minute and produces a reconstruction that cannot possibly solve. Failures are
 * reported through `reliable` so the caller can warn instead of pretending.
 */
function probeVideo(input) {
  return new Promise((resolveProbe) => {
    const probeBin = existsSync(commands.ffprobe) ? commands.ffprobe : 'ffprobe';
    const child = spawn(probeBin, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames,avg_frame_rate,width,height', '-show_entries', 'format=duration', '-of', 'json', input], { windowsHide: true });
    let out = '';
    const guard = setTimeout(() => {
      killTree(child);
      resolveProbe({ ...PROBE_FALLBACK, error: 'ffprobe timed out' });
    }, 60_000);
    child.stdout.on('data', (chunk) => { out += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(guard);
      resolveProbe({ ...PROBE_FALLBACK, error: error.message });
    });
    child.on('close', () => {
      clearTimeout(guard);
      try {
        const json = JSON.parse(out);
        const stream = json.streams?.[0] || {};
        const duration = Number(json.format?.duration);
        const rate = String(stream.avg_frame_rate || '24/1').split('/');
        const fps = Number(rate[0] || 24) / Number(rate[1] || 1);
        const frames = Number(stream.nb_frames) || Math.round(duration * fps);
        if (!Number.isFinite(duration) || duration <= 0) {
          resolveProbe({ ...PROBE_FALLBACK, error: 'no duration reported' });
          return;
        }
        resolveProbe({
          duration,
          frames: Number.isFinite(frames) && frames > 0 ? frames : Math.round(duration * 24),
          width: Number(stream.width) || 1280,
          height: Number(stream.height) || 720,
          reliable: true,
        });
      } catch (error) {
        resolveProbe({ ...PROBE_FALLBACK, error: error.message });
      }
    });
  });
}

/**
 * The mapper can split a flight into several disconnected models when tracking
 * breaks. Model `0` is not necessarily the good one, so pick whichever
 * registered the most images and report how much of the flight it covers.
 */
function registeredImageCount(dir) {
  const binary = join(dir, 'images.bin');
  if (!existsSync(binary)) return 0;
  try {
    const handle = openSync(binary, 'r');
    const header = Buffer.alloc(8);
    readSync(handle, header, 0, 8, 0);
    closeSync(handle);
    const count = Number(header.readBigUInt64LE(0));
    return Number.isFinite(count) && count >= 0 && count < 1e6 ? count : 0;
  } catch {
    return 0;
  }
}

function chooseSparseModel(sparse) {
  if (!existsSync(sparse)) return { path: sparse, images: 0, models: 0 };
  const candidates = [];
  for (const entry of readdirSync(sparse, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(sparse, entry.name);
    if (!existsSync(join(dir, 'images.bin')) && !existsSync(join(dir, 'images.txt'))) continue;
    candidates.push({ path: dir, images: registeredImageCount(dir) });
  }
  if (!candidates.length) return { path: sparse, images: 0, models: 0 };
  candidates.sort((a, b) => b.images - a.images);
  return { path: candidates[0].path, images: candidates[0].images, models: candidates.length };
}

/**
 * The pipeline as a declared list of stages.
 *
 * `referenceSeconds` are measured, not guessed: they come from the timestamps
 * in `runtime/0c7f4613-.../engine.log`, a 10 s / 90-frame clip that ran the
 * current settings end to end (mapper 442 s, dense stereo 522 s, everything
 * else under a minute). Weights are derived from those numbers so the bar
 * spends its time where the pipeline actually spends its time.
 */
export const PIPELINE_STAGES = [
  { key: 'extract', label: 'Extracting frames', detail: 'FFmpeg samples and sharpens the flight', referenceSeconds: 4 },
  { key: 'features', label: 'Detecting GPU features', detail: 'SIFT keypoints per frame on the GPU', referenceSeconds: 6.4 },
  { key: 'match', label: 'Matching sequential views', detail: 'Guided sequential matching across the pass', referenceSeconds: 43.2 },
  { key: 'mapper', label: 'Solving camera poses', detail: 'Incremental SfM and bundle adjustment', referenceSeconds: 300 },
  { key: 'undistort', label: 'Undistorting images', detail: 'Preparing the dense workspace', referenceSeconds: 2.1 },
  { key: 'stereo', label: 'Dense stereo on GPU', detail: 'Two passes: photometric, then geometric consistency', referenceSeconds: 300 },
  { key: 'fusion', label: 'Fusing dense point cloud', detail: 'Merging agreeing depth maps into one cloud', referenceSeconds: 46.9 },
  { key: 'products', label: 'Building terrain products', detail: 'Gravity-aligned surface, ortho atlas and GLB', referenceSeconds: 12 },
];

const REFERENCE_FRAMES = 90;

/**
 * Scales the reference timings to this clip and normalises them into weights.
 *
 * Frame extraction is the one stage that tracks clip length rather than frame
 * count: FFmpeg decodes the whole video no matter how few frames it keeps.
 * Everything after it is paid per frame.
 */
export function buildStagePlan({ durationSec = 10, frameCount = REFERENCE_FRAMES } = {}) {
  const frameScale = Math.max(0.2, (Number(frameCount) || REFERENCE_FRAMES) / REFERENCE_FRAMES);
  const seconds = PIPELINE_STAGES.map((stage) => (
    stage.key === 'extract'
      ? 2.5 + Math.max(0, Number(durationSec) || 0) * 0.12
      : stage.referenceSeconds * frameScale
  ));
  const total = seconds.reduce((sum, value) => sum + value, 0) || 1;
  return PIPELINE_STAGES.map((stage, index) => ({
    key: stage.key,
    label: stage.label,
    detail: stage.detail,
    weight: seconds[index] / total,
    expectedSeconds: seconds[index],
  }));
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Tracks which stage is running and how far into it we are, and writes the
 * result onto the job so the API, the SSE stream and the CLI all see the same
 * numbers.
 *
 * ETA is pure measurement: elapsed time divided by the fraction of total weight
 * completed, minus the elapsed time. That self-corrects when the declared
 * weights are wrong for a particular clip, which they will sometimes be.
 */
export function createProgressTracker(job, plan = buildStagePlan(), now = () => Date.now()) {
  const stages = plan.map((stage) => ({
    ...stage,
    status: 'pending',
    startedAt: null,
    endedAt: null,
    fraction: 0,
  }));
  const totalWeight = stages.reduce((sum, stage) => sum + stage.weight, 0) || 1;
  const startedAt = now();
  let index = -1;
  let highWater = 0;

  const overallFraction = () => {
    let done = 0;
    for (let i = 0; i < stages.length; i += 1) {
      if (i < index) done += stages[i].weight;
      else if (i === index) done += stages[i].weight * stages[i].fraction;
    }
    return clamp01(done / totalWeight);
  };

  const publish = (detail = null) => {
    const fraction = Math.max(highWater, overallFraction());
    highWater = fraction;
    const elapsedMs = now() - startedAt;
    // Below ~2% the sample is too short to extrapolate from and the estimate
    // swings by tens of minutes, so say nothing rather than something silly.
    const etaMs = fraction > 0.02 && fraction < 1 ? Math.round((elapsedMs * (1 - fraction)) / fraction) : null;
    const current = stages[index] || null;
    job.progress = Math.round(fraction * 1000) / 10;
    job.stage = current ? current.label : 'Queued';
    job.stageKey = current?.key || null;
    job.stageIndex = index;
    job.stageCount = stages.length;
    job.stageProgress = current ? Math.round(current.fraction * 1000) / 10 : 0;
    job.stageDetail = detail;
    job.startedAt = new Date(startedAt).toISOString();
    job.elapsedMs = elapsedMs;
    job.etaMs = etaMs;
    job.stages = stages.map((stage) => ({
      key: stage.key,
      label: stage.label,
      detail: stage.detail,
      weight: Math.round(stage.weight * 10000) / 10000,
      status: stage.status,
      progress: Math.round(stage.fraction * 1000) / 10,
      startedAt: stage.startedAt ? new Date(stage.startedAt).toISOString() : null,
      endedAt: stage.endedAt ? new Date(stage.endedAt).toISOString() : null,
      durationMs: stage.startedAt ? (stage.endedAt || now()) - stage.startedAt : null,
    }));
    return job;
  };

  const describe = (update) => {
    if (!update) return null;
    const passPart = update.passes > 1 ? ` · pass ${update.pass}/${update.passes}` : '';
    const nouns = { view: 'view', fuse: 'image', file: 'frame', image: 'frame', register: 'camera', frame: 'frame' };
    const noun = nouns[update.kind] || 'step';
    return `${noun} ${Math.min(update.done, update.total)}/${update.total}${passPart}`;
  };

  return {
    stages,
    /** Move to `key`, closing every stage before it. A null key only relabels. */
    start(key, label) {
      if (!key) {
        if (index >= 0 && label) stages[index].label = label;
        return publish();
      }
      const next = stages.findIndex((stage) => stage.key === key);
      if (next < 0) return publish();
      for (let i = 0; i <= next - 1; i += 1) {
        if (stages[i].status !== 'complete') {
          stages[i].status = 'complete';
          stages[i].fraction = 1;
          stages[i].startedAt = stages[i].startedAt || now();
          stages[i].endedAt = stages[i].endedAt || now();
        }
      }
      if (next !== index) {
        index = next;
        stages[next].startedAt = stages[next].startedAt || now();
        stages[next].fraction = 0;
      }
      stages[next].status = 'active';
      if (label) stages[next].label = label;
      return publish();
    },
    fraction(value, update = null) {
      if (index < 0) return job;
      stages[index].fraction = Math.max(stages[index].fraction, clamp01(value));
      return publish(describe(update));
    },
    complete(key) {
      const target = key ? stages.findIndex((stage) => stage.key === key) : index;
      if (target < 0) return publish();
      stages[target].fraction = 1;
      stages[target].status = 'complete';
      stages[target].startedAt = stages[target].startedAt || now();
      stages[target].endedAt = now();
      if (target === index && index < stages.length - 1) index = target;
      return publish();
    },
    /** Marks the run finished: every stage complete, 100%, no ETA. */
    finish() {
      for (const stage of stages) {
        if (stage.status !== 'complete') {
          stage.status = 'complete';
          stage.fraction = 1;
          stage.startedAt = stage.startedAt || now();
          stage.endedAt = stage.endedAt || now();
        }
      }
      index = stages.length - 1;
      highWater = 1;
      publish();
      job.progress = 100;
      job.stage = 'Complete';
      job.stageProgress = 100;
      job.etaMs = 0;
      return job;
    },
    /** Skipped stages still have to stop blocking the bar. */
    skip(key, reason = null) {
      const target = stages.findIndex((stage) => stage.key === key);
      if (target < 0 || stages[target].status === 'complete') return publish();
      stages[target].fraction = 1;
      stages[target].status = 'skipped';
      stages[target].startedAt = stages[target].startedAt || now();
      stages[target].endedAt = now();
      if (index < target) index = target;
      return publish(reason);
    },
    snapshot: () => publish(job.stageDetail),
  };
}

export function cpuThreads() {
  try { return Math.max(2, availableParallelism()); } catch { return 8; }
}

/** Blank or invalid means "use every core". */
export function normalizeThreads(value) {
  const cores = cpuThreads();
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return String(cores);
  return String(Math.min(cores, Math.max(1, Math.round(n))));
}

/** Blank means the profile picks the frame count. Hard cap keeps a 10 min pass inside the time budget. */
export function normalizeFrames(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(240, Math.max(12, Math.round(n)));
}

export function normalizeQuality(value) {
  const mode = String(value || 'fast').toLowerCase();
  if (mode === 'detailed' || mode === 'studio' || mode === 'survey' || mode === 'full') return 'detailed';
  if (mode === 'balanced' || mode === 'standard') return 'balanced';
  return 'fast';
}

/**
 * Stereo time scales with frames × pixels × samples × iterations × 2
 * (the second factor is the geometric-consistency pass). A measured 80-frame
 * 1280 px run spent ~13 min in stereo and ~8 min in CPU bundle adjustment.
 * Rapid stays lighter than Detailed by using a 1024 px depth map, fewer
 * PatchMatch iterations, and GPU bundle adjustment. It still samples fast
 * flights densely enough that neighbouring frames overlap — a 67 s FPV pass
 * at 0.6 fps registered only a fragment and the mesh covered almost nothing.
 * Geometric consistency stays on in every profile — dropping it is what
 * turns the cloud into spray.
 */
function surfaceFor(quality, tier) {
  const shared = {
    cpu: { resolution: 360, smoothing: 3, slope: 2.5, ortho: 1024, points: 120000 },
    low: { resolution: 480, smoothing: 2, slope: 3.2, ortho: 1280, points: 160000 },
  };
  const ranked = {
    mid: {
      fast: { resolution: 760, smoothing: 2, slope: 4.6, ortho: 1792, points: 300000 },
      balanced: { resolution: 800, smoothing: 1, slope: 5.2, ortho: 1792, points: 320000 },
      detailed: { resolution: 960, smoothing: 1, slope: 7, ortho: 2048, points: 420000 },
    },
    high: {
      fast: { resolution: 840, smoothing: 1, slope: 5.5, ortho: 1920, points: 340000 },
      balanced: { resolution: 1024, smoothing: 1, slope: 6.5, ortho: 2048, points: 420000 },
      detailed: { resolution: 1200, smoothing: 1, slope: 7.5, ortho: 2048, points: 480000 },
    },
  };
  if (ranked[tier]) return ranked[tier][quality] || ranked[tier].fast;
  const base = shared[tier] || shared.cpu;
  if (quality === 'detailed') {
    return { ...base, resolution: Math.round(base.resolution * 1.35), smoothing: 1, slope: base.slope + 1.5, ortho: 1536 };
  }
  if (quality === 'balanced') return { ...base, resolution: Math.round(base.resolution * 1.15), slope: base.slope + 0.6 };
  return base;
}

/**
 * Minimum frames so a moving camera still shares scene between neighbours.
 * A fixed preset (40 frames on a one-minute clip) is too sparse for FPV:
 * the mapper discards most of the flight and the DSM is a sliver.
 */
function framesForMotion(quality, durationSec, presetCount) {
  const policy = {
    fast: { rate: durationSec <= 120 ? 2 : durationSec <= 300 ? 1.5 : 1, floor: 72, cap: 180 },
    balanced: { rate: durationSec <= 120 ? 2.2 : durationSec <= 300 ? 1.6 : 1.1, floor: 80, cap: 200 },
    detailed: { rate: durationSec <= 120 ? 2.5 : durationSec <= 300 ? 1.8 : 1.2, floor: 96, cap: 220 },
  }[quality] || { rate: 2, floor: 72, cap: 180 };
  const fromRate = Math.ceil(Math.max(1, durationSec) * policy.rate);
  return Math.min(policy.cap, Math.max(policy.floor, presetCount, fromRate));
}

export function qualitySettings(mode, durationSec = 10, overrides = {}, hardware = null) {
  const quality = normalizeQuality(mode);
  const band = durationSec <= 90 ? 'short' : durationSec >= 480 ? 'long' : 'mid';
  const hw = hardware || classifyHardware({ logicalThreads: cpuThreads(), ramMb: 16384, vramMb: 8192, gpuName: 'NVIDIA GPU' });
  const presets = {
    fast: {
      frames: { short: 72, mid: 96, long: 120 },
      features: '12000',
      overlap: '16',
      dense: { short: '1024', mid: '1024', long: '960' },
      samples: '6',
      iterations: '3',
      baGlobalRefinements: '1',
      baGlobalIterations: '20',
      baLocalIterations: '12',
      baGlobalRatio: '1.4',
      baGlobalFreq: '1000',
      baLocalImages: '8',
      peakThreshold: '0.006',
      initTriAngle: '4',
      minMatches: '12',
    },
    balanced: {
      frames: { short: 56, mid: 80, long: 96 },
      features: '12000',
      overlap: '16',
      dense: { short: '1280', mid: '1024', long: '960' },
      samples: '7',
      iterations: '4',
      baGlobalRefinements: '2',
      baGlobalIterations: '25',
      baLocalIterations: '20',
      baGlobalRatio: '1.32',
      baGlobalFreq: '500',
      baLocalImages: '6',
      peakThreshold: '0.006',
      initTriAngle: '6',
      minMatches: '15',
    },
    detailed: {
      frames: { short: 72, mid: 100, long: 120 },
      features: '16000',
      overlap: '16',
      dense: { short: '1280', mid: '1280', long: '1024' },
      samples: '8',
      iterations: '4',
      baGlobalRefinements: '2',
      baGlobalIterations: '30',
      baLocalIterations: '25',
      baGlobalRatio: '1.2',
      baGlobalFreq: '400',
      baLocalImages: '8',
      peakThreshold: '0.004',
      initTriAngle: '8',
      minMatches: '15',
    },
  };
  const preset = presets[quality];
  const scaledPreset = Math.round(preset.frames[band] * (hw.frameScale || 1));
  // The motion floor wins over a too-small manual count. Typing 40 frames
  // on a one-minute FPV pass is what left the last Rapid mesh empty.
  const motionFloor = framesForMotion(quality, durationSec, scaledPreset);
  const sourceCap = Math.max(12, Math.floor(Math.max(durationSec, 1) * 12));
  const targetFrames = Math.min(240, sourceCap, Math.max(motionFloor, overrides.frames || 0));
  let dense = Number(preset.dense[band]);
  if (hw.tier === 'mid' && quality === 'fast') dense = band === 'long' ? 960 : 1024;
  if (hw.tier === 'high') dense = Math.round(dense * (quality === 'fast' ? 1.1 : 1.2));
  dense = Math.min(Math.max(512, dense), hw.denseCap || 1024);
  const fps = Math.min(12, Math.max(0.15, targetFrames / Math.max(durationSec, 1)));
  const surface = surfaceFor(quality, hw.tier);
  return {
    quality,
    exportMode: quality,
    hardware: hw,
    surface,
    fps: fps.toFixed(3),
    targetFrames,
    threads: overrides.threads ? normalizeThreads(overrides.threads) : String(hw.workerThreads),
    scale: hw.tier === 'high' && quality === 'detailed' ? '1600:-2' : '1280:-2',
    features: preset.features,
    overlap: preset.overlap,
    denseSize: String(dense),
    samples: preset.samples,
    iterations: preset.iterations,
    windowRadius: '5',
    windowStep: '2',
    stereoCache: String(hw.cacheGb || 4),
    fusionCache: String(Math.min(4, hw.cacheGb || 4)),
    baGlobalRefinements: preset.baGlobalRefinements,
    baGlobalRatio: preset.baGlobalRatio,
    baGlobalIterations: preset.baGlobalIterations,
    baLocalIterations: preset.baLocalIterations,
    baGlobalFreq: preset.baGlobalFreq,
    baLocalImages: preset.baLocalImages,
    poissonDepth: quality === 'detailed' ? '11' : '10',
    poissonTrim: '3',
    peakThreshold: preset.peakThreshold,
    initTriAngle: preset.initTriAngle || '8',
    minMatches: preset.minMatches || '15',
    minTriangulation: '1.0',
    filterTriangulation: '2.0',
  };
}

/**
 * Altitude drives the metric scale of every exported product, so an absurd or
 * missing value would silently mis-size the whole model rather than fail.
 */
export function normalizeAltitude(value, fallback = 82) {
  const altitude = Number(value);
  if (!Number.isFinite(altitude) || altitude <= 0) return fallback;
  return Math.min(2000, Math.max(2, altitude));
}

async function firstExisting(paths) {
  for (const path of paths) {
    if (existsSync(path)) return path;
  }
  return null;
}

export async function reconstruct(job) {
  const work = job.work;
  const frames = join(work, 'frames');
  const database = join(work, 'database.db');
  const sparse = join(work, 'sparse');
  const dense = join(work, 'dense');
  const products = join(work, 'products');
  await mkdir(frames, { recursive: true });
  await mkdir(sparse, { recursive: true });
  await mkdir(dense, { recursive: true });
  await mkdir(products, { recursive: true });

  if (!existsSync(job.input) || statSync(job.input).size < 64 * 1024) {
    throw new Error('The uploaded video is empty or truncated.');
  }
  for (const [name, binary] of [['FFmpeg', commands.ffmpeg], ['COLMAP', commands.colmap]]) {
    if (!existsSync(binary)) {
      throw new Error(`${name} was not found at ${binary}. Set the ${name.toUpperCase()}_PATH environment variable.`);
    }
  }

  const info = await probeVideo(job.input);
  if (!info.reliable) {
    job.warning = `Could not read the clip's duration (${info.error || 'unknown error'}); sampling assumes ${info.duration}s, so frame coverage may be wrong.`;
  }
  const hardware = hardwareFromTelemetry(await sampleTelemetry());
  job.hardware = hardware;
  const quality = qualitySettings(job.quality, info.duration, {
    frames: normalizeFrames(job.frames),
    threads: job.threads || null,
  }, hardware);
  job.profile = quality.quality;
  const tracker = createProgressTracker(job, buildStagePlan({
    durationSec: info.duration,
    frameCount: quality.targetFrames,
  }));
  job.tracker = tracker;
  tracker.start('extract', `Extracting ${quality.targetFrames} frames from the full flight`);
  await run(commands.ffmpeg, [
    '-y',
    '-threads', quality.threads,
    // Audio and subtitle streams are decoded and thrown away otherwise.
    '-an', '-sn', '-dn',
    '-i', job.input,
    '-vf', `fps=${quality.fps},scale=${quality.scale}:flags=lanczos,unsharp=5:5:0.45:5:5:0.0`,
    '-q:v', '2',
    join(frames, 'frame_%06d.jpg'),
  ], work, job, `Extracting ${quality.targetFrames} frames from the full flight`, {
    stage: 'extract',
    total: quality.targetFrames,
  });

  const frameCount = (await readdir(frames)).filter((name) => name.endsWith('.jpg')).length;
  if (frameCount < 8) throw new Error(`Only ${frameCount} frames were extracted. Need a longer or more detailed clip.`);
  tracker.complete('extract');

  await run(commands.colmap, [
    'feature_extractor',
    '--database_path', database,
    '--image_path', frames,
    '--ImageReader.single_camera', '1',
    '--SiftExtraction.max_num_features', quality.features,
    '--SiftExtraction.max_num_orientations', '2',
    '--SiftExtraction.peak_threshold', quality.peakThreshold,
    '--SiftExtraction.edge_threshold', '10',
    '--FeatureExtraction.use_gpu', '1',
    '--FeatureExtraction.num_threads', quality.threads,
  ], work, job, 'Detecting GPU features', { stage: 'features', total: frameCount });
  tracker.complete('features');

  await run(commands.colmap, [
    'sequential_matcher',
    '--database_path', database,
    '--FeatureMatching.use_gpu', '1',
    '--FeatureMatching.guided_matching', '1',
    '--FeatureMatching.num_threads', quality.threads,
    '--SequentialMatching.overlap', quality.overlap,
    '--SequentialMatching.quadratic_overlap', '1',
    '--SequentialMatching.num_threads', quality.threads,
  ], work, job, 'Matching sequential drone views', { stage: 'match', total: frameCount });
  tracker.complete('match');

  // Capping global bundle-adjustment refinements is the single biggest sparse
  // saving available; it does not touch the dense settings that decide whether
  // the result is a surface or a noise cloud.
  // COLMAP 4.x renamed ba_global_images_ratio -> ba_global_frames_ratio.
  // Hover / slow-pan clips have tiny baselines, so the init triangulation
  // floor has to sit well below COLMAP's 16° default or the mapper never
  // finds a first pair.
  const mapperArgs = (useGpu) => [
    'mapper',
    '--database_path', database,
    '--image_path', frames,
    '--output_path', sparse,
    '--Mapper.num_threads', quality.threads,
    '--Mapper.ba_local_num_images', quality.baLocalImages,
    '--Mapper.ba_local_max_num_iterations', quality.baLocalIterations,
    '--Mapper.ba_global_frames_freq', quality.baGlobalFreq,
    '--Mapper.ba_global_max_refinements', quality.baGlobalRefinements,
    '--Mapper.ba_global_frames_ratio', quality.baGlobalRatio,
    '--Mapper.ba_global_points_ratio', quality.baGlobalRatio,
    '--Mapper.ba_global_max_num_iterations', quality.baGlobalIterations,
    '--Mapper.min_num_matches', quality.minMatches,
    '--Mapper.init_min_tri_angle', quality.initTriAngle,
    '--Mapper.filter_min_tri_angle', '1.0',
    '--Mapper.init_max_forward_motion', '0.99',
    ...(useGpu ? ['--Mapper.ba_use_gpu', '1', '--Mapper.ba_gpu_index', '0'] : []),
  ];
  const gpuFailure = (message) => /ba_use_gpu|CUDA|cublas|cusolver|no CUDA|invalid device/i.test(message);
  try {
    try {
      await run(commands.colmap, mapperArgs(true), work, job, `Solving camera poses on GPU (${quality.threads} CPU threads)`, { stage: 'mapper', total: frameCount });
    } catch (error) {
      const message = error.message || String(error);
      if (!gpuFailure(message) || message.includes('cancelled') || message.includes('timeout')) throw error;
      job.warning = `${job.warning || ''} GPU bundle adjustment was unavailable; solving poses on CPU.`.trim();
      await run(commands.colmap, mapperArgs(false), work, job, `Solving camera poses on CPU (${quality.threads} threads)`, { stage: 'mapper', total: frameCount });
    }
  } catch (error) {
    const message = error.message || String(error);
    if (message.includes('unrecognised option') || message.includes('cancelled') || message.includes('timeout')) throw error;
    if (!message.includes('No good initial image pair') && !message.includes('Failed to create') && !message.includes('failed with code')) throw error;
    await run(commands.colmap, [
      'exhaustive_matcher',
      '--database_path', database,
      '--FeatureMatching.use_gpu', '1',
      '--FeatureMatching.guided_matching', '1',
      '--FeatureMatching.num_threads', quality.threads,
    ], work, job, 'Retry: exhaustive matching', { stage: 'match', total: frameCount });
    await run(commands.colmap, mapperArgs(false), work, job, 'Retry: solving camera poses', { stage: 'mapper', total: frameCount });
  }

  const chosen = chooseSparseModel(sparse);
  const sparseModel = chosen.path;
  if (chosen.images && chosen.images < 8) {
    throw new Error(`Only ${chosen.images} of ${frameCount} frames could be positioned. The clip needs more overlap or more texture to reconstruct.`);
  }
  if (chosen.models > 1) {
    job.warning = `${job.warning || ''} Tracking broke into ${chosen.models} separate models; using the largest (${chosen.images} frames).`.trim();
  } else if (chosen.images && chosen.images < frameCount * 0.6) {
    job.warning = `${job.warning || ''} Only ${chosen.images} of ${frameCount} frames were positioned, so coverage is partial.`.trim();
  }
  const sparsePly = join(work, 'sparse_points.ply');
  await run(commands.colmap, [
    'model_converter',
    '--input_path', sparseModel,
    '--output_path', sparsePly,
    '--output_type', 'PLY',
  ], work, job, 'Exporting sparse point cloud', { stage: 'mapper' });
  tracker.complete('mapper');

  let denseCloud = existsSync(sparsePly) ? sparsePly : null;
  try {
    await run(commands.colmap, [
      'image_undistorter',
      '--image_path', frames,
      '--input_path', sparseModel,
      '--output_path', dense,
      '--output_type', 'COLMAP',
      '--max_image_size', quality.denseSize,
    ], work, job, 'Undistorting images', { stage: 'undistort', total: frameCount });
    tracker.complete('undistort');
    await run(commands.colmap, [
      'patch_match_stereo',
      '--workspace_path', dense,
      '--workspace_format', 'COLMAP',
      // Cross-view geometric consistency is the difference between a surface
      // and a cloud of noise here: it rejects depths that neighbouring views
      // disagree about, which is most of them on a single forward pass.
      '--PatchMatchStereo.geom_consistency', '1',
      '--PatchMatchStereo.gpu_index', '0',
      '--PatchMatchStereo.max_image_size', quality.denseSize,
      '--PatchMatchStereo.window_radius', quality.windowRadius,
      '--PatchMatchStereo.window_step', quality.windowStep,
      '--PatchMatchStereo.num_samples', quality.samples,
      '--PatchMatchStereo.num_iterations', quality.iterations,
      '--PatchMatchStereo.min_triangulation_angle', quality.minTriangulation,
      '--PatchMatchStereo.filter_min_triangulation_angle', quality.filterTriangulation,
      '--PatchMatchStereo.filter_min_ncc', '0.10',
      '--PatchMatchStereo.filter_min_num_consistent', '2',
      '--PatchMatchStereo.cache_size', quality.stereoCache,
      '--PatchMatchStereo.num_threads', quality.threads,
      '--PatchMatchStereo.filter', '1',
      // Both passes walk every view, so the bar has two 1..N sweeps to cross.
    ], work, job, 'Building dense geometry on GPU with cross-view consistency', {
      stage: 'stereo',
      total: chosen.images || frameCount,
      passes: 2,
    });
    tracker.complete('stereo');
    await run(commands.colmap, [
      'stereo_fusion',
      '--workspace_path', dense,
      '--workspace_format', 'COLMAP',
      '--input_type', 'geometric',
      '--output_path', join(dense, 'fused.ply'),
      // Requiring agreement from five pixels rather than two trades roughly 80%
      // of the point count for a cloud that actually lies on the terrain.
      '--StereoFusion.min_num_pixels', '5',
      '--StereoFusion.max_reproj_error', '2',
      '--StereoFusion.max_depth_error', '0.01',
      '--StereoFusion.max_normal_error', '15',
      '--StereoFusion.cache_size', quality.fusionCache,
      '--StereoFusion.num_threads', quality.threads,
    ], work, job, 'Fusing dense point cloud', {
      stage: 'fusion',
      total: chosen.images || frameCount,
    });
    tracker.complete('fusion');
    if (existsSync(join(dense, 'fused.ply')) && statSync(join(dense, 'fused.ply')).size > 1024) {
      denseCloud = join(dense, 'fused.ply');
    } else {
      job.warning = `${job.warning || ''} Dense fusion produced no points; using the sparse cloud.`.trim();
    }
  } catch (error) {
    tracker.skip('stereo', error.message);
    tracker.skip('fusion', error.message);
    job.warning = `Dense stereo was skipped: ${error.message}. Using the sparse reconstruction.`;
  }

  if (!denseCloud) throw new Error('No point cloud was produced.');

  // Poisson meshing costs about a minute and writes a 150 MB mesh that
  // `buildProducts` never opens: the exported surface is a gravity-aligned DSM
  // rebuilt from the point cloud. It is kept behind a flag rather than deleted
  // in case the exporter starts consuming a mesh again.
  const poissonMesh = join(dense, 'poisson.ply');
  if (process.env.SKYFORGE_POISSON === '1') {
    try {
      await run(commands.colmap, [
        'poisson_mesher',
        '--input_path', denseCloud,
        '--output_path', poissonMesh,
        '--PoissonMeshing.depth', quality.poissonDepth,
        '--PoissonMeshing.color', '1',
        '--PoissonMeshing.trim', quality.poissonTrim,
        '--PoissonMeshing.num_threads', quality.threads,
      ], work, job, 'Meshing colored surface');
    } catch (error) {
      job.warning = `${job.warning || ''} Poisson meshing was skipped: ${error.message}`.trim();
    }
  }
  const meshPath = existsSync(poissonMesh) && statSync(poissonMesh).size > 2048 ? poissonMesh : denseCloud;

  tracker.start('products', 'Building textured terrain products');
  const productsResult = await buildProducts({
    cloudPath: denseCloud,
    meshPath,
    outDir: products,
    workDir: work,
    altitude: normalizeAltitude(job.altitude),
    sourceName: job.fileName || 'drone-pass.mp4',
    mode: quality.exportMode,
    surface: quality.surface,
  });

  const publicOut = resolve('output/latest');
  await mkdir(publicOut, { recursive: true });
  for (const file of Object.values(productsResult.files)) {
    if (!existsSync(file)) continue;
    await copyFile(file, join(publicOut, file.split(/[/\\]/).pop()));
  }

  tracker.finish();
  job.metrics = {
    ...productsResult.metadata,
    profile: quality.quality,
    framesUsed: frameCount,
    threads: Number(quality.threads),
    denseSize: Number(quality.denseSize),
    hardware: {
      tier: hardware.tier,
      gpu: hardware.gpuName,
      vramGb: hardware.vramGb,
      ramGb: hardware.ramGb,
      threads: hardware.workerThreads,
      cacheGb: hardware.cacheGb,
    },
  };
  job.result = {
    pointCloud: productsResult.files.pointCloud,
    model: productsResult.files.glb,
    mesh: productsResult.files.mesh,
    texturedModel: productsResult.files.glb,
    ortho: productsResult.files.ortho,
    metadata: productsResult.files.metadata,
    format: 'GLB terrain mesh + PLY point cloud',
    frameCount,
  };
}

export async function exportExistingJob(work, altitude = 82, fileName = 'existing-pass.mp4', mode = 'view') {
  const denseCloud = await firstExisting([
    join(work, 'dense', 'fused.ply'),
    join(work, 'dense', 'scene.ply'),
    join(work, 'sparse_points.ply'),
  ]);
  if (!denseCloud) throw new Error(`No reconstructed cloud found in ${work}`);
  const products = join(work, 'products');
  const result = await buildProducts({
    cloudPath: denseCloud,
    meshPath: existsSync(join(work, 'dense', 'poisson.ply')) ? join(work, 'dense', 'poisson.ply') : denseCloud,
    outDir: products,
    workDir: work,
    altitude: normalizeAltitude(altitude),
    sourceName: fileName,
    mode,
  });
  const publicOut = resolve('output/latest');
  await mkdir(publicOut, { recursive: true });
  for (const file of Object.values(result.files)) {
    if (!existsSync(file)) continue;
    await copyFile(file, join(publicOut, file.split(/[/\\]/).pop()));
  }
  return result;
}
