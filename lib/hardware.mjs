/**
 * Turns a telemetry sample into the reconstruction budget for this machine.
 *
 * Stereo memory is the hard limit: an 8 GB laptop GPU cannot hold a 1600 px
 * geometric-consistency workspace, and a hybrid CPU with 28 logical threads
 * will stall COLMAP if every efficiency core is put on bundle adjustment.
 * The numbers below are the caps, not the profile. The profile still chooses
 * frames and depth size inside these caps.
 */

const DENSE_CAP = { cpu: 640, low: 768, mid: 1152, high: 1600 };
const FRAME_SCALE = { cpu: 0.7, low: 0.85, mid: 1, high: 1.2 };
const CACHE_GB = { cpu: 1, low: 2, mid: 4, high: 6 };

export function classifyHardware({
  logicalThreads = 4,
  ramMb = 8192,
  vramMb = 0,
  gpuName = null,
  cpuModel = null,
} = {}) {
  const threads = Math.max(1, Number(logicalThreads) || 1);
  const ramGb = Math.max(0, Number(ramMb) || 0) / 1024;
  const vramGb = Math.max(0, Number(vramMb) || 0) / 1024;
  const gpu = vramGb >= 3.5;

  let tier = 'cpu';
  if (gpu && vramGb >= 10 && ramGb >= 24) tier = 'high';
  else if (gpu && vramGb >= 6 && ramGb >= 12) tier = 'mid';
  else if (gpu) tier = 'low';

  // Intel hybrid parts (the 14700HX reports 28 threads) are faster in COLMAP
  // when bundle adjustment stays on the performance cores. 16 threads is that
  // budget on a 16 GB machine; bigger RAM can feed more.
  let workerThreads = threads;
  if (ramGb < 12) workerThreads = Math.min(threads, 6);
  else if (ramGb < 24 && threads > 16) workerThreads = 16;
  else if (ramGb < 48 && threads > 24) workerThreads = 24;
  else workerThreads = Math.min(threads, 32);
  if (tier === 'cpu') workerThreads = Math.min(workerThreads, 8);
  if (tier === 'low') workerThreads = Math.min(workerThreads, 8);

  const cacheGb = Math.min(
    CACHE_GB[tier],
    gpu ? Math.max(1, Math.round(vramGb * 0.5)) : 1,
  );

  return {
    tier,
    gpu: Boolean(gpu),
    gpuName: gpuName || (gpu ? 'NVIDIA GPU' : null),
    cpuModel: cpuModel || null,
    logicalThreads: threads,
    workerThreads,
    ramGb: Math.round(ramGb * 10) / 10,
    vramGb: Math.round(vramGb * 10) / 10,
    cacheGb,
    denseCap: DENSE_CAP[tier],
    frameScale: FRAME_SCALE[tier],
  };
}

export function hardwareFromTelemetry(sample) {
  return classifyHardware({
    logicalThreads: sample?.cpu?.cores,
    ramMb: sample?.memory?.totalMb,
    vramMb: sample?.gpu?.available ? sample.gpu.memoryTotalMb : 0,
    gpuName: sample?.gpu?.name || null,
    cpuModel: sample?.cpu?.model || null,
  });
}

/** Short label for the console rail. */
export function hardwareLabel(hardware) {
  if (!hardware) return 'Detecting hardware…';
  const gpu = hardware.gpuName
    ? hardware.gpuName.replace(/^NVIDIA\s+GeForce\s+/i, '')
    : 'CPU only';
  const memory = hardware.vramGb ? `${hardware.vramGb} GB` : `${hardware.ramGb} GB RAM`;
  return `${gpu} · ${memory} · ${hardware.workerThreads} threads`;
}
