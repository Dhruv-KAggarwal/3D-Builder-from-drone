# Skyforge — 3D builder from one drone video

Turn **one drone clip** into a georeferenced, textured 3D terrain model on this machine. No cloud photogrammetry account. The path is tuned for an **RTX 4060 8 GB** laptop: 720p frames, 4 GB GPU cache, and a browser-sized GLB instead of a 160 MB raw dump.

```
Video → FFmpeg frames → COLMAP GPU pose
      → dense stereo with cross-view geometric consistency
      → gravity-aligned digital surface model → Three.js console
```

Repository: https://github.com/Dhruv-KAggarwal/3D-Builder-from-drone.git

---

## What you get

| Product | File | What it is |
| --- | --- | --- |
| Viewable mesh | `terrain.glb` | Hillshaded terrain + optional photo points, loads in the console |
| Mesh | `terrain.ply` | Same surface as PLY |
| Point cloud | `pointcloud.ply` | Subsampled coloured cloud |
| Orthophoto | `orthomosaic.png` | Top-down colour atlas baked from undistorted frames |
| Metadata | `metadata.json` | Extent, scale, coverage, camera count |

Products are written to `runtime/<job-id>/products/` and copied to `output/latest/`.

Two design choices dominate quality:

1. **Dense stereo uses geometric consistency.** Depths that neighbouring views disagree about are rejected. Without this, a single forward pass becomes a spray of points along view rays rather than a surface.
2. **The surface is a gravity-aligned DSM, not a Poisson mesh.** Poisson wraps a watertight balloon around an open, one-sided scan. That is the wrong primitive for a drone pass.

This is **terrain relief**, not a watertight BIM of every building. Towers show up as peaks; photo colour lives on the surface and in the Photo points overlay.

---

## Who this is for

Hackathon / field team on **Windows 10/11**, NVIDIA GPU, Git Bash or PowerShell. macOS/Linux can run the Node console, but the bundled engine paths are `.exe` — set `FFMPEG_PATH` / `COLMAP_PATH` to local binaries.

---

## Repository layout

```
3D-Builder-from-drone/
  src/                 UI (main.js, viewer.js, style.css)
  lib/                 Reconstruction + export (COLMAP, DSM, GLB, texture)
  tools/               Offline PNG renderer and diagnostics
  engines/             FFmpeg + COLMAP + optional OpenMVS  ← not in git; you install these
  runtime/<job-id>/    Scratch workspace for each run       ← gitignored
  output/latest/       Last finished products               ← gitignored
  server.mjs           API + static console on port 8787
  reconstruct-cli.mjs  Command-line reconstruction
  package.json
```

`node_modules/`, `runtime/`, `output/`, `dist/`, engine binaries, and videos are **not** committed. They are large and machine-specific.

---

## Requirements

| Need | Notes |
| --- | --- |
| Node.js 20+ | https://nodejs.org — includes `npm` |
| Git for Windows | Git Bash comes with it |
| NVIDIA GPU + recent Game Ready / Studio driver | COLMAP dense stereo is CUDA |
| ~10 GB free disk for engines, **50+ GB** if you keep several jobs |
| RAM | 16 GB is the design point; 4 GB is reserved for the stereo cache |

Confirm the GPU is visible:

```bash
nvidia-smi
```

---

## Setup (do this once per machine)

### 1. Clone

In **Git Bash**:

```bash
git clone https://github.com/Dhruv-KAggarwal/3D-Builder-from-drone.git
cd 3D-Builder-from-drone
```

### 2. Install Node packages

```bash
npm install
```

### 3. Install reconstruction engines

Binaries are **not** in git (GitHub rejects files over 100 MB). Follow [`engines/README.md`](engines/README.md).

Short version:

1. FFmpeg essentials → `engines/ffmpeg/bin/ffmpeg.exe` and `ffprobe.exe`
2. COLMAP **4.2 CUDA** → `engines/colmap/bin/colmap.exe`
3. OpenMVS is optional and unused for the default surface

Sanity check from Git Bash (from the repo root):

```bash
./engines/ffmpeg/bin/ffmpeg.exe -version
./engines/colmap/bin/colmap.exe -h | head
```

COLMAP 4.2 must list `--Mapper.ba_global_frames_ratio`. If you only see `ba_global_images_ratio`, you installed 3.x and pose solving will fail.

### 4. Build the console

```bash
npm run build
```

---

## Run the console

**Git Bash or PowerShell**, from the repo root:

```bash
npm run api
```

Opens **http://localhost:8787**

You should see `LOCAL ENGINE` healthy (`COLMAP + exporter online`) in the left rail. If it warns, FFmpeg or COLMAP is missing — go back to step 3.

Frontend hot-reload (API must already be running in another terminal):

```bash
npm run dev
```

Then use http://localhost:5173 — Vite proxies `/api` to port 8787.

### Reconstruct from the UI

1. Drop an `.mp4` / `.mov` / `.m4v` on **Capture package** (or Browse)
2. Pick **Rapid response** (fast, 4060-safe) or **Survey** (more frames / detail)
3. Set **Camera altitude** in metres AGL (used for metric scale when there is no GPS)
4. Click **Generate scene** (or `Ctrl+Enter`)
5. Wait. A 10 s clip is ~10–15 min; a 10 min pass is aimed under 15 min on a 4060
6. When the pipeline says **COMPLETE**, orbit the mesh. Enable **Photo points** for colour. **Shift-click** two points to measure
7. Download **GLB / PLY cloud / PLY mesh / Ortho** from the bar under the viewport

Jobs also appear under **3D outputs**. **Measure & analyse** shows extent, coverage, point count, and faces.

---

## Reconstruct from the CLI

Useful when you already have a path and do not want to upload through the browser.

**Git Bash** (note the `--` so npm forwards the video path):

```bash
npm run reconstruct -- "/c/Users/<you>/Videos/flight.mp4" --altitude=82
```

Survey / higher detail:

```bash
npm run reconstruct -- "/c/Users/<you>/Videos/flight.mp4" --studio --altitude=120
```

PowerShell:

```powershell
npm run reconstruct -- "C:\Users\<you>\Videos\flight.mp4" --altitude=82
```

Flags:

| Flag | Meaning |
| --- | --- |
| *(default)* | Rapid (`fast`) profile |
| `--studio` | Survey profile — more features / frames |
| `--altitude=N` | Flight height AGL in metres (scale). Clamped 2–2000, default 82 |
| `--reuse=runtime/<job-id>` | Rebuild GLB/PLY/ortho from an existing COLMAP job, skip stereo |
| `--full` | With `--reuse`, finer DSM grid, lighter smoothing |

Rebuild products without running stereo again:

```bash
node reconstruct-cli.mjs --reuse=runtime/<job-id> --altitude=82
node reconstruct-cli.mjs --reuse=runtime/<job-id> --full --altitude=82
```

Replace `<job-id>` with a folder name under `runtime/` (a UUID).

---

## Inspect a model without the browser

```bash
node tools/render.mjs output/latest/terrain.ply --out=output/look.png --az=55 --el=32
node tools/render.mjs output/latest/pointcloud.ply --out=output/cloud.png --splat=1
```

---

## How to fly so the model actually solves

Photogrammetry needs **parallax**. A perfectly static hover with no camera motion cannot reconstruct 3D.

- One **smooth pass** (or a slow pan), 60%+ overlap between frames
- Locked exposure, no auto-zoom
- 720p or higher, 24–60 fps
- 30 seconds to 10 minutes is the sweet spot
- Avoid empty water, glare, and textureless sky as the only content
- Hover **plus a pan/orbit** is OK; hover locked on one point of view is not

Altitude in the UI does not change geometry — it only scales the scene so measurements are in metres. If you do not know AGL, 80–120 m is a reasonable survey default; a high city pass may be 200–400 m.

---

## Pipeline stages (what the progress bar is doing)

| Stage | Engine | Typical share of time |
| --- | --- | --- |
| Extract frames | FFmpeg | Seconds |
| Detect GPU features | COLMAP SIFT | Seconds |
| Match sequential views | COLMAP | ~1 min / 80 frames |
| Solve camera poses | COLMAP mapper | Several minutes |
| Undistort | COLMAP | Seconds |
| Dense stereo (2 passes) | COLMAP PatchMatch CUDA | Longest stage |
| Fuse cloud | COLMAP | Under a minute |
| Terrain products | Node (DSM + GLB) | Seconds |

Only **one** reconstruction should run at a time. Two dense jobs on one GPU thrash VRAM and can corrupt each other’s depth maps.

---

## HTTP API (if you wire another client)

Base URL: `http://localhost:8787`

| Method | Path | Role |
| --- | --- | --- |
| `GET` | `/api/health` | FFmpeg / COLMAP / GPU status |
| `GET` | `/api/jobs` | Completed + in-memory jobs |
| `POST` | `/api/reconstruct` | Raw video body |
| `GET` | `/api/reconstruct/:id` | Job status |
| `GET` | `/api/reconstruct/:id/stream` | SSE progress |
| `GET` | `/api/reconstruct/:id/file?kind=glb\|cloud\|mesh\|ortho\|meta` | Download a product |

`POST /api/reconstruct` headers:

- `Content-Type`: `video/mp4` (or the real type)
- `X-File-Name`: original filename
- `X-Quality`: `fast` or `studio`
- `X-Altitude`: metres AGL (string)

---

## Environment variables

| Variable | Default |
| --- | --- |
| `PORT` | `8787` |
| `FFMPEG_PATH` | `engines/ffmpeg/bin/ffmpeg.exe` |
| `FFPROBE_PATH` | `engines/ffmpeg/bin/ffprobe.exe` |
| `COLMAP_PATH` | `engines/colmap/bin/colmap.exe` |
| `OPENMVS_PATH` | `engines/openmvs` |
| `SKYFORGE_POISSON` | unset. Set to `1` to also run Poisson meshing (not used by the exporter) |

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `LOCAL ENGINE` warning / API offline | Run `npm run api` from the repo root, not another folder |
| `FFmpeg was not found` / `COLMAP was not found` | Install engines as in [`engines/README.md`](engines/README.md) |
| `unrecognised option '--Mapper.ba_global_images_ratio'` | Old code or COLMAP 3.x. This repo uses **`--Mapper.ba_global_frames_ratio`** for COLMAP 4.2 |
| `unrecognised option '--Mapper.ba_global_frames_ratio'` | You installed COLMAP 3.x. Install 4.2 CUDA |
| `No good initial image pair` / few cameras registered | Clip has too little motion, blur, or texture. Fly a pass with overlap |
| Mapper succeeds, mesh is empty spray | Geometric consistency is on; if fusion is empty the exporter falls back to the sparse cloud |
| GPU util 0% during stereo | CPU COLMAP build, or another process holds the GPU. Close other COLMAP/game/3D jobs |
| Port already in use | `$env:PORT=8898; npm run api` (PowerShell) or `PORT=8898 npm run api` (Git Bash) |
| Console loads but no 3D | Confirm `output/latest/terrain.glb` exists, then refresh. Check the toast for viewer errors |
| Disk filling up | Delete old folders under `runtime/` — each job can be many GB |

Keep **one** `npm run api` process. Killing the terminal should take COLMAP with it; if a `colmap.exe` is stuck, Task Manager → end task (it will otherwise starve the next job).

---

## Hardware notes (RTX 4060 8 GB)

- Stereo cache is capped at **4 GB**
- Fusion requires **five** agreeing pixels and geometric depth maps
- Clips longer than 45 s drop dense stereo to 960 px so a 10 min video still aims at a 15 min budget
- Do not raise `PatchMatchStereo.cache_size` on a 16 GB laptop — it will swap

---

## Team git workflow

Do **not** commit `runtime/`, `output/`, `node_modules/`, `engines/ffmpeg`, `engines/colmap`, or videos.

```bash
git checkout -b feat/my-change
# ... edit ...
git add -A
git status
git commit -m "Explain why this change exists."
git push -u origin feat/my-change
```

Open a pull request against `main` on GitHub.

---

## License

FFmpeg: GPL/LGPL · COLMAP: BSD 3-Clause · OpenMVS: AGPL v3 · Skyforge: MIT
