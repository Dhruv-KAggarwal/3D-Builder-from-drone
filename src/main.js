import './style.css';
import { ModelViewer } from './viewer.js';

const API = window.location.port === '5173' ? '' : '';
const app = document.querySelector('#app');
const state = {
  file: null,
  job: null,
  jobs: [],
  processing: false,
  activeView: 'mission',
  quality: 'Rapid',
  layers: { terrain: true, points: false, grid: true },
  health: null,
};

const fallbackStages = [
  { key: 'extract', label: 'Extracting frames', detail: 'FFmpeg samples and sharpens the flight' },
  { key: 'features', label: 'Detecting GPU features', detail: 'SIFT keypoints per frame on the GPU' },
  { key: 'match', label: 'Matching sequential views', detail: 'Guided sequential matching across the pass' },
  { key: 'mapper', label: 'Solving camera poses', detail: 'Incremental SfM and bundle adjustment' },
  { key: 'undistort', label: 'Undistorting images', detail: 'Preparing the dense workspace' },
  { key: 'stereo', label: 'Dense stereo on GPU', detail: 'Photometric then geometric consistency' },
  { key: 'fusion', label: 'Fusing dense point cloud', detail: 'Merging agreeing depth maps' },
  { key: 'products', label: 'Building terrain products', detail: 'Gravity-aligned surface and photo texture' },
];

app.innerHTML = `
  <div class="app-shell">
    <aside class="rail">
      <div class="brand"><span class="brand-symbol">◈</span><div><b>SKYFORGE</b><small>SINGLE-PASS MAPPING</small></div></div>
      <div class="mission-selector"><small>ACTIVE MISSION</small><strong id="mission-name">NIGHT SURVEY 01</strong><span>⌄</span></div>
      <nav>
        <button class="nav-item active" data-view="mission"><span>⌖</span>Mission control</button>
        <button class="nav-item" data-view="models"><span>◫</span>3D outputs <i id="model-count">0</i></button>
        <button class="nav-item" data-view="analysis"><span>⌁</span>Measure & analyse</button>
      </nav>
      <div class="rail-foot"><div class="engine-status"><span class="status-dot"></span><div><b>LOCAL ENGINE</b><small id="engine-copy">Checking engines…</small></div></div><button class="rail-link" id="docs">?  Field guide</button><div class="operator"><span>SF</span><div><b>Skyforge Operator</b><small>Single-pass recon</small></div><em>⌄</em></div></div>
    </aside>
    <main>
      <header class="topbar"><div><p class="kicker">OPERATIONAL MAPPING / <span id="clock"></span></p><h1>Mission control</h1></div><div class="top-actions"><span class="secure">● LOCAL PROCESSING</span><button class="outline-btn" id="new-mission">＋ New mission</button></div></header>
      <section class="mission-banner"><div><span class="live-tag"><b></b> READY FOR SINGLE PASS</span><h2>Build a measurable world<br><em>from one flight.</em></h2><p>Turn one drone video into a georeferenced, textured 3D scene on this machine. RTX 4060 path: native 720p frames, 4 GB GPU cache, no second pass.</p></div><div class="banner-stats"><div><b>01</b><span>PASS REQUIRED</span></div><div><b>&lt;15<span>min</span></b><span>TARGET RUNTIME</span></div><div><b>3D</b><span>MESH + CLOUD</span></div></div></section>
      <div class="view" id="mission-view">
        <section class="workspace-grid">
          <div class="card ingest-card"><div class="card-head"><div><span class="step">01</span><div><p class="kicker">MISSION INPUT</p><h3>Capture package</h3></div></div><span class="help">i</span></div><div class="dropzone" id="dropzone"><div class="drop-icon">↑</div><strong id="drop-title">Drop single-pass video here</strong><p id="drop-subtitle">MP4, MOV or M4V · 720p / 4K · streamed to disk</p><button class="text-btn" id="browse">Browse footage <span>→</span></button><input id="file-input" type="file" accept="video/*" hidden /></div><div class="file-row" id="file-row" hidden><div class="file-icon">▣</div><div><b id="file-name"></b><small id="file-meta"></small></div><button id="remove-file">×</button></div><div class="input-checks"><label><input type="checkbox" checked id="imu"> IMU / flight metadata attached</label><label><input type="checkbox" id="rtk"> RTK / PPK correction available</label></div></div>
          <div class="card config-card"><div class="card-head"><div><span class="step">02</span><div><p class="kicker">RECONSTRUCTION PROFILE</p><h3>Set mission parameters</h3></div></div></div><label class="field-label">OUTPUT FOCUS</label><div class="profile-grid"><button class="profile" data-quality="Survey"><b>Survey</b><small>Full scene · metric-first</small><span>✓</span></button><button class="profile active" data-quality="Rapid"><b>Rapid response</b><small>Fast geometry · 4060 safe</small><span>✓</span></button></div><div class="config-row"><label><span>Camera altitude</span><b><input id="altitude" value="82" type="number"> m AGL</b></label><label><span>Coordinate system</span><b><select id="crs"><option>Local tangent plane</option><option>WGS 84 / UTM 43N</option><option>WGS 84 / UTM 44N</option></select></b></label></div><label class="field-label">OUTPUTS</label><div class="output-chips"><button class="chip active">Textured mesh</button><button class="chip active">Point cloud</button><button class="chip active">Orthomosaic</button><button class="chip active">DEM mesh</button></div><button class="generate-btn" id="generate" disabled><span>◈</span> Generate scene <kbd>Ctrl ↵</kbd></button><p class="estimate" id="estimate">Upload a capture package to estimate runtime</p></div>
        </section>
        <section class="card pipeline-card"><div class="pipeline-head"><div><p class="kicker">PROCESSING PIPELINE</p><h3 id="pipeline-title">Waiting for capture package</h3></div><div class="pipeline-meta"><span class="pipeline-time" id="pipeline-time">—</span><span class="pipeline-eta" id="pipeline-eta"></span></div></div><div class="pipeline-steps" id="pipeline-steps"></div><div class="progress-wrap"><div class="progress-label"><span id="stage-label">Awaiting mission start</span><b id="progress-value">0%</b></div><div class="progress-track"><i id="progress-bar"></i></div></div><div class="telemetry" id="telemetry"><span>GPU <b id="tel-gpu">—</b></span><span>VRAM <b id="tel-vram">—</b></span><span>RAM <b id="tel-ram">—</b></span><span>CPU <b id="tel-cpu">—</b></span><span>TEMP <b id="tel-temp">—</b></span></div></section>
        <section class="scene-section"><div class="section-title"><div><p class="kicker">SCENE PREVIEW</p><h3>Operational digital twin</h3></div><div class="layer-controls">${Object.entries({ terrain: 'Terrain', points: 'Photo points', grid: 'Grid' }).map(([key, label]) => `<button class="layer${key === 'points' ? '' : ' active'}" data-layer="${key}"><i></i>${label}</button>`).join('')}</div></div><div class="scene-card"><canvas id="scene-canvas"></canvas><div class="load-overlay" id="load-overlay" hidden><b id="load-pct">0%</b><small>Streaming terrain mesh</small></div><div class="scene-overlay"><span class="map-pill">◉ <span id="scene-state">PREVIEW / NO MODEL YET</span></span><span class="north">N</span><div class="scene-legend"><span><i class="legend-structure"></i>SHIFT-CLICK MEASURE</span><span><i class="legend-road"></i>ORBIT DRAG</span><span><i class="legend-terrain"></i>SCROLL ZOOM</span></div></div></div><div class="scene-footer"><span id="scene-caption">Upload a single-pass flight or load the last reconstructed scene</span><div class="download-bar" id="download-bar" hidden><a id="dl-glb">GLB</a><a id="dl-cloud">PLY cloud</a><a id="dl-mesh">PLY mesh</a><a id="dl-ortho">Ortho</a></div></div></section>
      </div>
      <div class="view hidden" id="models-view"><section class="page-heading"><p class="kicker">3D OUTPUTS</p><h2>Mission library</h2><p>Local reconstruction packages ready for inspection, measurement and export.</p></section><div class="model-grid" id="models-grid"></div><div class="empty-state" id="models-empty"><span>◫</span><h3>No completed missions yet</h3><p>Run a single-pass reconstruction to see your textured mesh, point cloud and terrain products here.</p><button class="outline-btn" data-go="mission">Start a mission</button></div></div>
      <div class="view hidden" id="analysis-view"><section class="page-heading"><p class="kicker">MEASURE & ANALYSE</p><h2>Scene intelligence</h2><p>Accuracy and coverage tools become available after reconstruction.</p></section><div class="analysis-grid"><div class="analysis-card"><span>METRIC SCALE</span><b id="analysis-scale">—</b><small id="analysis-scale-copy">Waiting for georeferenced output</small></div><div class="analysis-card"><span>VISIBLE COVERAGE</span><b id="analysis-coverage">—</b><small id="analysis-coverage-copy">Entire visible scene</small></div><div class="analysis-card"><span>EXPORT PACKAGE</span><b>GLB · PLY</b><small>OBJ-ready mesh · ortho PNG</small></div><div class="analysis-card"><span>POINT COUNT</span><b id="analysis-points">—</b><small>Dense / sparse fused cloud</small></div><div class="analysis-card"><span>MESH FACES</span><b id="analysis-faces">—</b><small>Textured terrain surface</small></div><div class="analysis-card"><span>MEASUREMENT</span><b id="analysis-measure">Shift-click</b><small id="analysis-measure-copy">Hold Shift and click two scene points</small></div></div></div>
      <footer><span>SKYFORGE // v1.0.0 FIELD BUILD</span><span>Designed for disaster response · inspection · reconnaissance</span></footer>
    </main>
  </div>
  <div class="toast" id="toast"></div>
`;

const $ = (id) => document.getElementById(id);
const dropzone = $('dropzone');
const input = $('file-input');
const viewer = new ModelViewer($('scene-canvas'));
viewer.onProgress = (pct, loaded, total) => {
  const overlay = $('load-overlay');
  overlay.hidden = false;
  $('load-pct').textContent = `${pct}%`;
  $('scene-state').textContent = `LOADING TERRAIN / ${pct}%`;
  $('progress-value').textContent = `${pct}%`;
  $('progress-bar').style.width = `${pct}%`;
  $('stage-label').textContent = total
    ? `Streaming terrain ${formatBytes(loaded)} of ${formatBytes(total)}`
    : `Streaming terrain ${formatBytes(loaded)}`;
};
viewer.onMeasure = ({ meters, message }) => {
  $('analysis-measure').textContent = meters == null ? '…' : `${meters.toFixed(2)} m`;
  $('analysis-measure-copy').textContent = message;
  toast(message);
};

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 3200);
}
function formatBytes(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value > 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}
function fileUrl(id, kind) {
  return `${API}/api/reconstruct/${id}/file?kind=${kind}`;
}
function setDownloads(id) {
  const bar = $('download-bar');
  if (!id) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  $('dl-glb').href = fileUrl(id, 'glb');
  $('dl-cloud').href = fileUrl(id, 'cloud');
  $('dl-mesh').href = fileUrl(id, 'mesh');
  $('dl-ortho').href = fileUrl(id, 'ortho');
  ['dl-glb', 'dl-cloud', 'dl-mesh', 'dl-ortho'].forEach((key) => { $(key).download = ''; });
}
function applyMetrics(job) {
  const metrics = job?.metrics;
  if (!metrics) return;
  const extent = metrics.extentM || [];
  $('analysis-scale').textContent = `${extent[0]?.toFixed?.(0) || '—'} × ${extent[2]?.toFixed?.(0) || '—'} m`;
  $('analysis-scale-copy').textContent = metrics.crs || 'Altitude-scaled local metres';
  $('analysis-coverage').textContent = `${metrics.points?.toLocaleString?.() || '—'} pts`;
  $('analysis-coverage-copy').textContent = `${metrics.meshFaces?.toLocaleString?.() || '—'} terrain faces`;
  $('analysis-points').textContent = metrics.points?.toLocaleString?.() || '—';
  $('analysis-faces').textContent = metrics.meshFaces?.toLocaleString?.() || '—';
  if (metrics.photoCoverage != null) {
    $('analysis-coverage').textContent = `${Math.round(metrics.photoCoverage * 100)}% photo`;
    $('analysis-coverage-copy').textContent = metrics.textureSize
      ? `Orthophoto ${metrics.textureSize[0]}×${metrics.textureSize[1]}`
      : 'Photographic surface coverage';
  }
  $('scene-caption').textContent = `${metrics.source || 'Scene'} · ${metrics.meshVertices?.toLocaleString?.() || metrics.points} verts · ${metrics.meshFaces} faces`;
}
async function showJob(job) {
  state.job = job;
  $('mission-name').textContent = (job.fileName || 'MISSION').toUpperCase().slice(0, 22);
  $('scene-state').textContent = 'MODEL READY / GEOREFERENCED';
  $('pipeline-title').textContent = 'Digital twin ready for analysis';
  $('pipeline-time').textContent = 'COMPLETE';
  updateProgress({ progress: 100, stage: 'Complete' });
  setDownloads(job.id);
  applyMetrics(job);
  try {
    $('scene-state').textContent = 'LOADING TERRAIN / 0%';
    $('stage-label').textContent = 'Streaming hillshaded terrain into the viewport';
    $('load-overlay').hidden = false;
    await viewer.loadGlb(fileUrl(job.id, 'glb'));
    $('load-overlay').hidden = true;
    $('scene-state').textContent = 'TERRAIN READY / ORBIT TO INSPECT';
    toast('Terrain loaded. Orbit to inspect relief, enable Photo points for colour, Shift-click to measure.');
  } catch (error) {
    toast(`Viewer could not load the mesh: ${error.message}`);
    $('load-overlay').hidden = true;
  }
}
function setFile(file) {
  if (!file || !file.type.startsWith('video/')) return toast('Select a video capture package.');
  state.file = file;
  $('file-row').hidden = false;
  $('file-name').textContent = file.name;
  $('file-meta').textContent = `${formatBytes(file.size)} · ${file.type.split('/')[1]?.toUpperCase() || 'VIDEO'} · ready`;
  dropzone.classList.add('loaded');
  $('drop-title').textContent = 'Capture package loaded';
  $('drop-subtitle').textContent = 'Telemetry will be fused when processing starts';
  $('generate').disabled = false;
  $('estimate').textContent = state.quality === 'Rapid' ? 'Estimated runtime · under 15 min for a 10 min pass' : 'Estimated runtime · higher detail · still aimed under 15 min';
  toast('Capture package ready for mission processing.');
}
function resetFile() {
  state.file = null;
  input.value = '';
  $('file-row').hidden = true;
  dropzone.classList.remove('loaded');
  $('drop-title').textContent = 'Drop single-pass video here';
  $('drop-subtitle').textContent = 'MP4, MOV or M4V · 720p / 4K · streamed to disk';
  $('generate').disabled = true;
  $('estimate').textContent = 'Upload a capture package to estimate runtime';
}
function setView(view) {
  state.activeView = view;
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  document.querySelectorAll('.view').forEach((item) => item.classList.toggle('hidden', item.id !== `${view}-view`));
  if (view !== 'mission') {
    const heading = document.querySelector('h1');
    if (heading) heading.textContent = view === 'models' ? '3D outputs' : 'Measure & analyse';
  } else {
    const heading = document.querySelector('h1');
    if (heading) heading.textContent = 'Mission control';
  }
  viewer.resize();
}
function renderModels() {
  const grid = $('models-grid');
  const empty = $('models-empty');
  const complete = state.jobs.filter((job) => job.status === 'complete' && job.result);
  $('model-count').textContent = String(complete.length);
  if (!complete.length) {
    empty.hidden = false;
    grid.innerHTML = '';
    return;
  }
  empty.hidden = true;
  grid.innerHTML = complete.map((job) => `
    <article class="model-card">
      <img src="${fileUrl(job.id, 'ortho')}" alt="" />
      <div>
        <b>${job.fileName || job.id.slice(0, 8)}</b>
        <small>${job.metrics?.points?.toLocaleString?.() || '—'} points · ${job.metrics?.meshFaces?.toLocaleString?.() || '—'} faces</small>
        <div class="model-actions">
          <button data-open="${job.id}">Open in viewport</button>
          <a href="${fileUrl(job.id, 'glb')}" download>Download GLB</a>
        </div>
      </div>
    </article>
  `).join('');
  grid.querySelectorAll('[data-open]').forEach((button) => {
    button.addEventListener('click', async () => {
      const job = state.jobs.find((item) => item.id === button.dataset.open);
      if (job) {
        await showJob(job);
        setView('mission');
      }
    });
  });
}
async function refreshJobs() {
  try {
    const response = await fetch(`${API}/api/jobs`);
    state.jobs = await response.json();
    renderModels();
    return state.jobs;
  } catch {
    return [];
  }
}
async function checkHealth() {
  try {
    const response = await fetch(`${API}/api/health`);
    state.health = await response.json();
    $('engine-copy').textContent = state.health.colmap ? 'COLMAP + exporter online' : 'Engine needs attention';
    if (!state.health.colmap) $('engine-status')?.classList.add('warning');
  } catch {
    $('engine-copy').textContent = 'API offline · start npm run api';
    $('engine-status')?.classList.add('warning');
  }
}
function watchJob(id, onUpdate) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (job, error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(job);
    };
    const poll = async () => {
      try {
        while (!settled) {
          await new Promise((wait) => setTimeout(wait, 1000));
          const status = await fetch(`${API}/api/reconstruct/${id}`);
          const job = await status.json();
          onUpdate(job);
          if (job.status && job.status !== 'processing') {
            done(job);
            return;
          }
        }
      } catch (error) {
        done(null, error);
      }
    };
    if (typeof EventSource !== 'function') {
      poll();
      return;
    }
    const stream = new EventSource(`${API}/api/reconstruct/${id}/stream`);
    stream.addEventListener('progress', (event) => {
      try { onUpdate(JSON.parse(event.data)); } catch { /* ignore a truncated frame */ }
    });
    stream.addEventListener('done', (event) => {
      stream.close();
      try { done(JSON.parse(event.data)); } catch (error) { done(null, error); }
    });
    stream.addEventListener('error', () => {
      stream.close();
      if (!settled) poll();
    });
  });
}
async function reconstruct() {
  if (!state.file || state.processing) return;
  state.processing = true;
  $('generate').disabled = true;
  $('pipeline-title').textContent = 'Reconstructing single-pass scene';
  $('scene-state').textContent = 'PROCESSING / LIVE TELEMETRY';
  $('pipeline-time').textContent = 'RUNNING';
  renderStages(fallbackStages);
  try {
    const response = await fetch(`${API}/api/reconstruct`, {
      method: 'POST',
      headers: {
        'Content-Type': state.file.type || 'video/mp4',
        'X-File-Name': state.file.name,
        'X-Quality': state.quality === 'Rapid' ? 'fast' : 'studio',
        'X-Altitude': String($('altitude').value || '82'),
      },
      body: state.file,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not start reconstruction.');
    const job = await watchJob(payload.id, updateProgress);
    if (job.status !== 'complete') throw new Error(job.error || 'Reconstruction failed.');
    toast(job.warning || 'Scene complete. Metric model is ready.');
    await refreshJobs();
    await showJob(job);
  } catch (error) {
    toast(error.message);
    $('pipeline-title').textContent = 'Processing stopped — review capture quality';
    $('scene-state').textContent = 'PREVIEW / PROCESSING ERROR';
    $('pipeline-time').textContent = 'ERROR';
  } finally {
    state.processing = false;
    $('generate').disabled = !state.file;
  }
}
function formatDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  const seconds = Math.max(0, Math.round(Number(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}
function formatTelemetry(job) {
  const tel = job?.telemetry;
  if (!tel) return;
  const gpu = tel.gpu || {};
  $('tel-gpu').textContent = gpu.utilisationPercent == null ? '—' : `${Math.round(gpu.utilisationPercent)}%`;
  $('tel-vram').textContent = gpu.memoryUsedMb == null ? '—' : `${Math.round(gpu.memoryUsedMb)} / ${Math.round(gpu.memoryTotalMb || 0)} MB`;
  $('tel-ram').textContent = tel.memory?.usedPercent == null ? '—' : `${tel.memory.usedPercent}%`;
  $('tel-cpu').textContent = tel.cpu?.loadPercent == null ? '—' : `${tel.cpu.loadPercent}%`;
  $('tel-temp').textContent = gpu.temperatureC == null ? '—' : `${Math.round(gpu.temperatureC)}°C`;
}
function renderStages(list) {
  const steps = list?.length ? list : fallbackStages.map((stage) => ({ ...stage, status: 'pending', progress: 0 }));
  $('pipeline-steps').innerHTML = steps.map((stage, index) => `
    <div class="pipeline-step ${stage.status || 'pending'}" data-stage="${stage.key}">
      <span class="pipeline-index">${String(index + 1).padStart(2, '0')}</span>
      <div><b>${stage.label}</b><small>${stage.detail || ''}${stage.status === 'active' && stage.progress ? ` · ${stage.progress}%` : ''}</small></div>
      <strong>${stage.status === 'complete' ? 'DONE' : stage.status === 'active' ? 'LIVE' : stage.status === 'skipped' ? 'SKIP' : 'WAIT'}</strong>
    </div>
  `).join('');
}
function updateProgress(job) {
  const progress = Number(job.progress || 0);
  $('progress-value').textContent = `${progress}%`;
  $('progress-bar').style.width = `${progress}%`;
  const detail = job.stageDetail ? ` · ${job.stageDetail}` : '';
  $('stage-label').textContent = `${job.stage || 'Processing…'}${detail}`;
  if (job.status === 'processing') {
    $('pipeline-time').textContent = `ELAPSED ${formatDuration(job.elapsedMs)}`;
    $('pipeline-eta').textContent = job.etaMs ? `ETA ${formatDuration(job.etaMs)}` : 'ETA —';
  } else if (job.status === 'complete') {
    $('pipeline-time').textContent = 'COMPLETE';
    $('pipeline-eta').textContent = job.elapsedMs ? formatDuration(job.elapsedMs) : '';
  }
  renderStages(job.stages);
  formatTelemetry(job);
}

input.addEventListener('change', (event) => setFile(event.target.files[0]));
$('browse').addEventListener('click', () => input.click());
dropzone.addEventListener('click', (event) => { if (event.target.tagName !== 'BUTTON') input.click(); });
dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('dragging'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', (event) => { event.preventDefault(); dropzone.classList.remove('dragging'); setFile(event.dataTransfer.files[0]); });
$('remove-file').addEventListener('click', resetFile);
$('generate').addEventListener('click', reconstruct);
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') reconstruct();
});
document.querySelectorAll('.profile').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.profile').forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  state.quality = button.dataset.quality;
  $('estimate').textContent = state.file ? (state.quality === 'Rapid' ? 'Estimated runtime · under 15 min for a 10 min pass' : 'Estimated runtime · higher detail · still aimed under 15 min') : 'Upload a capture package to estimate runtime';
}));
document.querySelectorAll('.chip').forEach((button) => button.addEventListener('click', () => button.classList.toggle('active')));
document.querySelectorAll('.layer').forEach((button) => button.addEventListener('click', () => {
  const key = button.dataset.layer;
  state.layers[key] = !state.layers[key];
  button.classList.toggle('active', state.layers[key]);
  viewer.setLayers(state.layers);
}));
document.querySelectorAll('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
document.querySelectorAll('[data-go="mission"]').forEach((button) => button.addEventListener('click', () => setView('mission')));
$('new-mission').addEventListener('click', () => {
  resetFile();
  state.job = null;
  $('scene-state').textContent = 'PREVIEW / NO MODEL YET';
  $('pipeline-title').textContent = 'Waiting for capture package';
  $('pipeline-time').textContent = '—';
  updateProgress({ progress: 0, stage: 'Awaiting mission start', stages: fallbackStages });
  setDownloads(null);
  setView('mission');
});
$('docs').addEventListener('click', () => toast('One smooth pass, locked exposure, 60% overlap. Terrain is the hillshaded mesh. Photo points overlay the original colours. Shift-click two points to measure.'));
setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }, 1000);

await checkHealth();
if (state.health?.telemetry) formatTelemetry({ telemetry: state.health.telemetry });
renderStages(fallbackStages);
const jobs = await refreshJobs();
if (jobs[0]?.status === 'complete') await showJob(jobs[0]);
viewer.resize();
