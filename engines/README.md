# Place FFmpeg, COLMAP, and optional OpenMVS here

Skyforge looks for Windows binaries in this folder. **Do not commit the binaries** — they exceed GitHub’s 100 MB file limit (`ffmpeg.exe` is ~101 MB).

After unzipping, this tree must exist:

```
engines/
  ffmpeg/bin/ffmpeg.exe
  ffmpeg/bin/ffprobe.exe
  colmap/bin/colmap.exe
  openmvs/                    (optional)
```

## FFmpeg 8.x

1. Download **ffmpeg-release-essentials.zip** from https://www.gyan.dev/ffmpeg/builds/
2. Extract so `ffmpeg.exe` and `ffprobe.exe` sit in `engines/ffmpeg/bin/`

## COLMAP 4.2 CUDA (required)

CPU-only COLMAP will crawl. Use a **CUDA** build.

1. Open https://github.com/colmap/colmap/releases and download the Windows CUDA zip for **4.2.x**
2. Extract the archive
3. Copy the `bin` folder (and any sibling `lib` folder the zip includes) to `engines/colmap/`
4. Confirm `engines/colmap/bin/colmap.exe` exists
5. First launch may trigger Windows Defender — allow it

If `colmap mapper -h` does **not** list `--Mapper.ba_global_frames_ratio`, you have COLMAP 3.x. This project is written for 4.2 (`frames_ratio`, not `images_ratio`).

## OpenMVS (optional)

The default surface is a COLMAP dense cloud + gravity-aligned DSM. OpenMVS is not required.

If you still want it, extract OpenMVS 2.4 CUDA into `engines/openmvs/`.

## Custom install locations

You can skip this folder and point at system installs:

```bash
export FFMPEG_PATH="/c/ffmpeg/bin/ffmpeg.exe"
export FFPROBE_PATH="/c/ffmpeg/bin/ffprobe.exe"
export COLMAP_PATH="/c/COLMAP/bin/colmap.exe"
```

On PowerShell:

```powershell
$env:FFMPEG_PATH = "C:\ffmpeg\bin\ffmpeg.exe"
$env:FFPROBE_PATH = "C:\ffmpeg\bin\ffprobe.exe"
$env:COLMAP_PATH = "C:\COLMAP\bin\colmap.exe"
```
