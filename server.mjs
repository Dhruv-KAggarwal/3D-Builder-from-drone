import { createServer } from 'node:http';
import { createWriteStream, createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { extname, join, resolve, normalize, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { rm } from 'node:fs/promises';
import {
  commands,
  engineAvailable,
  normalizeAltitude,
  queueExclusive,
  reconstruct,
  terminateAllEngines,
  buildStagePlan,
} from './lib/reconstruct.mjs';
import { sampleTelemetry } from './lib/telemetry.mjs';

const port = Number(process.env.PORT || 8787);
const root = resolve('runtime');
const dist = resolve('dist');
const jobs = new Map();
/** Open SSE sockets, closed on client disconnect and on process shutdown. */
const liveStreams = new Set();

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.ply': 'application/octet-stream',
  '.svg': 'image/svg+xml',
};

function cors(response, type = 'application/json') {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-File-Name, X-Quality, X-Altitude, X-Crs');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  response.setHeader('Content-Type', type);
}

function send(response, status, body, type = 'application/json') {
  cors(response, type);
  response.writeHead(status);
  response.end(type.startsWith('application/json') && typeof body !== 'string' && !Buffer.isBuffer(body) ? JSON.stringify(body) : body);
}

/** Stage list for a job that has not reached the pipeline yet. */
const queuedStages = () => buildStagePlan().map((stage) => ({
  key: stage.key,
  label: stage.label,
  detail: stage.detail,
  weight: Math.round(stage.weight * 10000) / 10000,
  status: 'pending',
  progress: 0,
  startedAt: null,
  endedAt: null,
  durationMs: null,
}));

function jobPayload(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    stageKey: job.stageKey ?? null,
    stageIndex: job.stageIndex ?? -1,
    stageCount: job.stageCount ?? null,
    stageProgress: job.stageProgress ?? 0,
    stageDetail: job.stageDetail ?? null,
    stages: job.stages || queuedStages(),
    startedAt: job.startedAt ?? null,
    elapsedMs: job.elapsedMs ?? null,
    etaMs: job.status === 'processing' ? (job.etaMs ?? null) : 0,
    cancelled: Boolean(job.cancelled),
    warning: job.warning,
    error: job.error,
    result: job.result,
    metrics: job.metrics,
    fileName: job.fileName,
  };
}

async function listJobs() {
  const listed = [...jobs.values()].map(jobPayload);
  if (!existsSync(root)) return listed;
  const folders = await readdir(root);
  for (const id of folders) {
    if (listed.some((job) => job.id === id)) continue;
    const glb = join(root, id, 'products', 'terrain.glb');
    const metaPath = join(root, id, 'products', 'metadata.json');
    if (!existsSync(glb)) continue;
    let metrics = null;
    try { metrics = JSON.parse(await readFile(metaPath, 'utf8')); } catch { /* ignore */ }
    listed.push({
      id,
      status: 'complete',
      progress: 100,
      stage: 'Complete',
      stageKey: null,
      stageIndex: -1,
      stageProgress: 100,
      stageDetail: null,
      stages: queuedStages().map((stage) => ({ ...stage, status: 'complete', progress: 100 })),
      startedAt: null,
      elapsedMs: null,
      etaMs: 0,
      result: {
        model: glb,
        pointCloud: join(root, id, 'products', 'pointcloud.ply'),
        mesh: join(root, id, 'products', 'terrain.ply'),
        ortho: join(root, id, 'products', 'orthomosaic.png'),
        metadata: metaPath,
        format: 'GLB terrain mesh + PLY point cloud',
      },
      metrics,
      fileName: metrics?.source || id,
    });
  }
  return listed.sort((a, b) => String(b.metrics?.generatedAt || '').localeCompare(String(a.metrics?.generatedAt || '')));
}

function fileFor(job, kind) {
  const recovered = join(root, job?.id || '', 'products');
  const latest = resolve('output/latest');
  const table = {
    glb: [job?.result?.model, join(recovered, 'terrain.glb'), join(latest, 'terrain.glb')],
    full: [join(recovered, 'terrain-full.glb'), join(latest, 'terrain-full.glb'), join(recovered, 'terrain.glb')],
    cloud: [job?.result?.pointCloud, join(recovered, 'pointcloud.ply'), join(latest, 'pointcloud.ply')],
    mesh: [job?.result?.mesh, join(recovered, 'terrain.ply'), join(latest, 'terrain.ply')],
    ortho: [job?.result?.ortho, join(recovered, 'orthomosaic.png'), join(latest, 'orthomosaic.png')],
    meta: [job?.result?.metadata, join(recovered, 'metadata.json'), join(latest, 'metadata.json')],
  };
  return (table[kind] || table.glb).find((path) => path && existsSync(path));
}

function streamFile(response, filePath, type) {
  cors(response, type);
  const name = filePath.split(/[/\\]/).pop();
  const size = statSync(filePath).size;
  response.setHeader('Content-Disposition', `inline; filename="${name}"`);
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Length', String(size));
  const stream = createReadStream(filePath);
  stream.on('error', (error) => {
    if (!response.headersSent) send(response, 500, { error: error.message });
  });
  stream.pipe(response);
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://localhost:${port}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = resolve(dist, normalize(pathname.replace(/^[/\\]+/, '')));
  const escaped = relative(dist, filePath);
  if (!escaped || escaped.startsWith('..') || escaped.startsWith('/') || !existsSync(filePath)) {
    return send(response, 404, { error: 'Not found.' });
  }
  const info = await stat(filePath);
  if (info.isDirectory()) return send(response, 404, { error: 'Not found.' });
  streamFile(response, filePath, mime[extname(filePath)] || 'application/octet-stream');
}

function writeSse(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function openJobStream(id, request, response) {
  cors(response, 'text/event-stream; charset=utf-8');
  response.writeHead(200, {
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof response.flushHeaders === 'function') response.flushHeaders();

  let closed = false;
  const client = { response, id };
  liveStreams.add(client);
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    liveStreams.delete(client);
    try { response.end(); } catch { /* already gone */ }
  };
  request.on('close', close);

  const pump = async () => {
    if (closed) return;
    const telemetry = await sampleTelemetry();
    const live = jobs.get(id);
    if (live) {
      writeSse(response, 'progress', { ...jobPayload(live), telemetry });
      if (live.status !== 'processing') {
        writeSse(response, 'done', { ...jobPayload(live), telemetry });
        close();
      }
      return;
    }
    const listed = (await listJobs()).find((job) => job.id === id);
    if (listed) {
      writeSse(response, 'done', { ...listed, telemetry });
      close();
      return;
    }
    writeSse(response, 'error', { error: 'Job not found.', telemetry });
    close();
  };

  const timer = setInterval(() => { pump().catch(() => close()); }, 1000);
  await pump().catch(() => close());
}

async function handle(request, response) {
  if (request.method === 'OPTIONS') return send(response, 204, '');
  const url = new URL(request.url, `http://localhost:${port}`);

  if (request.method === 'GET' && url.pathname === '/api/health') {
    const [ffmpeg, colmap, telemetry] = await Promise.all([
      engineAvailable(commands.ffmpeg),
      engineAvailable(commands.colmap),
      sampleTelemetry(),
    ]);
    const running = [...jobs.values()].filter((job) => job.status === 'processing');
    return send(response, 200, {
      gpu: process.env.CUDA_VISIBLE_DEVICES !== '-1',
      ffmpeg,
      colmap,
      openmvs: existsSync(commands.openmvs),
      latest: existsSync(resolve('output/latest/terrain.glb')),
      ready: ffmpeg && colmap,
      activeJobs: running.length,
      telemetry,
    });
  }

  if (request.method === 'GET' && url.pathname === '/api/telemetry') {
    return send(response, 200, await sampleTelemetry());
  }

  if (request.method === 'GET' && url.pathname === '/api/jobs') {
    return send(response, 200, await listJobs());
  }

  if (request.method === 'POST' && url.pathname === '/api/reconstruct') {
    const chunksHint = Number(request.headers['content-length'] || 0);
    if (chunksHint > 3.5 * 1024 * 1024 * 1024) return send(response, 413, { error: 'Video is larger than 3.5 GB.' });

    // Fail before the upload rather than after it: a multi-gigabyte transfer
    // that dies on a missing binary wastes the operator's time for nothing.
    for (const [name, binary] of [['FFmpeg', commands.ffmpeg], ['COLMAP', commands.colmap]]) {
      if (!existsSync(binary)) {
        return send(response, 503, { error: `${name} is not installed at ${binary}.` });
      }
    }

    const id = randomUUID();
    const work = join(root, id);
    await mkdir(work, { recursive: true });
    const fileName = String(request.headers['x-file-name'] || 'capture.mp4').replace(/[/\\]/g, '_');
    const input = join(work, `input${extname(fileName) || '.mp4'}`);
    try {
      await pipeline(request, createWriteStream(input));
    } catch (error) {
      await rm(work, { recursive: true, force: true }).catch(() => {});
      return send(response, 400, { error: `Upload failed: ${error.message}` });
    }
    if (!existsSync(input) || statSync(input).size < 64 * 1024) {
      await rm(work, { recursive: true, force: true }).catch(() => {});
      return send(response, 400, { error: 'The uploaded video is empty or truncated.' });
    }

    const requestedQuality = String(request.headers['x-quality'] || 'fast').toLowerCase();
    const job = {
      id,
      work,
      input,
      fileName,
      quality: requestedQuality === 'studio' ? 'studio' : 'fast',
      altitude: normalizeAltitude(request.headers['x-altitude']),
      progress: 0,
      stage: 'Queued behind another reconstruction',
      status: 'processing',
      cancelHooks: new Set(),
    };
    jobs.set(id, job);
    queueExclusive(() => reconstruct(job))
      .then(() => { job.status = 'complete'; })
      .catch((error) => {
        job.status = 'error';
        job.error = error.message;
      });
    return send(response, 202, { id });
  }

  const cancelMatch = url.pathname.match(/^\/api\/reconstruct\/([^/]+)\/cancel$/);
  if (request.method === 'POST' && cancelMatch) {
    const job = jobs.get(cancelMatch[1]);
    if (!job) return send(response, 404, { error: 'Job not found.' });
    if (job.status !== 'processing') return send(response, 409, { error: `Job is already ${job.status}.` });
    job.cancelled = true;
    for (const hook of job.cancelHooks || []) hook();
    return send(response, 200, { id: job.id, status: 'cancelling' });
  }

  const streamMatch = url.pathname.match(/^\/api\/reconstruct\/([^/]+)\/stream$/);
  if (request.method === 'GET' && streamMatch) {
    await openJobStream(streamMatch[1], request, response);
    return;
  }

  const match = url.pathname.match(/^\/api\/reconstruct\/([^/]+)$/);
  if (request.method === 'GET' && match) {
    const live = jobs.get(match[1]);
    if (live) return send(response, 200, { ...jobPayload(live), telemetry: await sampleTelemetry() });
    const listed = (await listJobs()).find((job) => job.id === match[1]);
    return listed ? send(response, 200, listed) : send(response, 404, { error: 'Job not found.' });
  }

  const fileMatch = url.pathname.match(/^\/api\/reconstruct\/([^/]+)\/file$/);
  if (request.method === 'GET' && fileMatch) {
    const kind = url.searchParams.get('kind') || 'glb';
    const job = jobs.get(fileMatch[1]) || { id: fileMatch[1], result: null };
    const filePath = fileFor(job, kind);
    if (!filePath) return send(response, 404, { error: 'Reconstruction output is not available.' });
    streamFile(response, filePath, mime[extname(filePath)] || 'application/octet-stream');
    return;
  }

  if (request.method === 'GET') return serveStatic(request, response);
  return send(response, 404, { error: 'Not found.' });
}

await mkdir(root, { recursive: true });
const server = createServer((request, response) => handle(request, response).catch((error) => send(response, 500, { error: error.message })));
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Skyforge API is already running on http://localhost:${port}.`);
    process.exitCode = 0;
    return;
  }
  console.error(error);
  process.exitCode = 1;
});
server.timeout = 0;
server.listen(port, () => {
  console.log(`Skyforge reconstruction console: http://localhost:${port}`);
});

// Without this the engines survive Ctrl+C, keep the GPU busy, and corrupt the
// dense workspace of whichever run starts next.
let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nStopping engines and shutting down (${signal})...`);
    terminateAllEngines();
    for (const client of liveStreams) {
      try { client.response.end(); } catch { /* already closed */ }
    }
    liveStreams.clear();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 4000).unref();
  });
}
process.on('exit', terminateAllEngines);
