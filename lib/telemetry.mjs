import { spawn } from 'node:child_process';
import { cpus, freemem, loadavg, totalmem } from 'node:os';

/**
 * Live machine telemetry for the reconstruction console.
 *
 * Everything here is best-effort: a missing driver, a busy GPU or a hung
 * `nvidia-smi` must degrade to nulls rather than take the API down, because the
 * only reason this module exists is to decorate a progress screen.
 */

const NVIDIA_SMI_ARGS = [
  '--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu',
  '--format=csv,noheader,nounits',
];

/** Long enough that a 10 Hz poll cannot spawn a process storm, short enough to look live. */
const SAMPLE_TTL_MS = 1000;
const PROBE_TIMEOUT_MS = 2500;
/** After nvidia-smi fails we stop asking for a while instead of retrying every second. */
const FAILURE_BACKOFF_MS = 60_000;

let cached = null;
let inFlight = null;
let gpuBlockedUntil = 0;
let gpuFailureReason = null;
let lastCpuSample = null;

function nvidiaSmiCommand() {
  return process.env.NVIDIA_SMI_PATH || 'nvidia-smi';
}

/**
 * Parses one nvidia-smi CSV row.
 * The live query is `name, utilization, memory.used, memory.total, temperature`.
 * A 4-field row without the name is still accepted.
 * Fields reported as `[N/A]` become null instead of NaN.
 */
export function parseNvidiaSmi(text) {
  const line = String(text || '')
    .split(/\r?\n/)
    .map((row) => row.trim())
    .find((row) => row.length > 0);
  if (!line) return null;
  const fields = line.split(',').map((field) => field.trim());
  if (fields.length < 4) return null;
  const numeric = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const tail = fields.slice(-4);
  const name = fields.length > 4 ? fields.slice(0, -4).join(', ').trim() : null;
  const [utilisation, used, total, temperature] = tail;
  const sample = {
    available: true,
    name: name || null,
    utilisationPercent: numeric(utilisation),
    memoryUsedMb: numeric(used),
    memoryTotalMb: numeric(total),
    temperatureC: numeric(temperature),
  };
  if (sample.utilisationPercent === null && sample.memoryTotalMb === null) return null;
  return sample;
}

function unavailableGpu(reason) {
  return {
    available: false,
    reason,
    utilisationPercent: null,
    memoryUsedMb: null,
    memoryTotalMb: null,
    temperatureC: null,
    name: null,
  };
}

function readGpu() {
  if (Date.now() < gpuBlockedUntil) {
    return Promise.resolve(unavailableGpu(gpuFailureReason || 'nvidia-smi unavailable'));
  }
  return new Promise((resolveGpu) => {
    let child;
    let settled = false;
    let stdout = '';
    const done = (value, failure) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      if (failure) {
        gpuFailureReason = failure;
        gpuBlockedUntil = Date.now() + FAILURE_BACKOFF_MS;
      } else {
        gpuFailureReason = null;
        gpuBlockedUntil = 0;
      }
      resolveGpu(value);
    };
    const guard = setTimeout(() => {
      try { child?.kill(); } catch { /* already gone */ }
      done(unavailableGpu('nvidia-smi timed out'), 'nvidia-smi timed out');
    }, PROBE_TIMEOUT_MS);

    try {
      child = spawn(nvidiaSmiCommand(), NVIDIA_SMI_ARGS, { windowsHide: true });
    } catch (error) {
      done(unavailableGpu(error.message), error.message);
      return;
    }
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', (error) => {
      const reason = error.code === 'ENOENT' ? 'nvidia-smi is not installed' : error.message;
      done(unavailableGpu(reason), reason);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        done(unavailableGpu(`nvidia-smi exited with code ${code}`), `nvidia-smi exited with code ${code}`);
        return;
      }
      const parsed = parseNvidiaSmi(stdout);
      if (!parsed) {
        done(unavailableGpu('nvidia-smi returned no usable row'), 'nvidia-smi returned no usable row');
        return;
      }
      done(parsed, null);
    });
  });
}

/**
 * CPU load as a percentage of all cores, measured between calls.
 * `os.loadavg()` is always zero on Windows, so the busy/idle tick deltas are
 * the only honest source here.
 */
export function readCpu() {
  const cores = cpus() || [];
  let busy = 0;
  let idle = 0;
  for (const core of cores) {
    const times = core.times || {};
    busy += (times.user || 0) + (times.nice || 0) + (times.sys || 0) + (times.irq || 0);
    idle += times.idle || 0;
  }
  const previous = lastCpuSample;
  lastCpuSample = { busy, idle };
  let loadPercent = null;
  if (previous) {
    const busyDelta = busy - previous.busy;
    const totalDelta = busyDelta + (idle - previous.idle);
    if (totalDelta > 0) loadPercent = Math.min(100, Math.max(0, (busyDelta / totalDelta) * 100));
  }
  return {
    cores: cores.length,
    model: cores[0]?.model?.trim() || null,
    loadPercent: loadPercent === null ? null : Number(loadPercent.toFixed(1)),
    loadAverage1m: Number(loadavg()[0].toFixed(2)) || 0,
  };
}

export function readMemory() {
  const total = totalmem();
  const free = freemem();
  const used = total - free;
  return {
    usedMb: Math.round(used / 1024 / 1024),
    freeMb: Math.round(free / 1024 / 1024),
    totalMb: Math.round(total / 1024 / 1024),
    usedPercent: total > 0 ? Number(((used / total) * 100).toFixed(1)) : null,
  };
}

/**
 * One cached telemetry sample. Concurrent callers inside the TTL share a single
 * `nvidia-smi` process; that is the whole point of the cache, since the SSE
 * stream, the polling fallback and the health endpoint all want this at once.
 */
export async function sampleTelemetry() {
  const now = Date.now();
  if (cached && now - cached.at < SAMPLE_TTL_MS) return cached.value;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const gpu = await readGpu();
    const value = {
      at: new Date().toISOString(),
      gpu,
      cpu: readCpu(),
      memory: readMemory(),
    };
    cached = { at: Date.now(), value };
    return value;
  })().finally(() => { inFlight = null; });
  return inFlight;
}

/** The most recent sample without spawning anything, or null before the first one. */
export function lastTelemetry() {
  return cached?.value || null;
}

/** Test hook: forget the cache and the nvidia-smi failure backoff. */
export function resetTelemetry() {
  cached = null;
  inFlight = null;
  gpuBlockedUntil = 0;
  gpuFailureReason = null;
  lastCpuSample = null;
}
