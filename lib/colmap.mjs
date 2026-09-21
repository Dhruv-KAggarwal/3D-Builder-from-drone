import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

function quaternionToMatrix(qw, qx, qy, qz) {
  const n = Math.hypot(qw, qx, qy, qz) || 1;
  const w = qw / n;
  const x = qx / n;
  const y = qy / n;
  const z = qz / n;
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ];
}

function poseFromQt(qw, qx, qy, qz, tx, ty, tz, name = '', cameraId = 0) {
  const R = quaternionToMatrix(qw, qx, qy, qz);
  // Camera centre in world coordinates: C = -R^T t
  const center = [
    -(R[0][0] * tx + R[1][0] * ty + R[2][0] * tz),
    -(R[0][1] * tx + R[1][1] * ty + R[2][1] * tz),
    -(R[0][2] * tx + R[1][2] * ty + R[2][2] * tz),
  ];
  // Rows of R are the camera axes expressed in world coordinates.
  const rightAxis = [R[0][0], R[0][1], R[0][2]];
  const downAxis = [R[1][0], R[1][1], R[1][2]];
  const viewAxis = [R[2][0], R[2][1], R[2][2]];
  return { center, rightAxis, downAxis, viewAxis, name, cameraId };
}

function parseImagesBin(buffer) {
  const poses = [];
  let offset = 0;
  const count = Number(buffer.readBigUInt64LE(offset));
  offset += 8;
  if (!Number.isFinite(count) || count <= 0 || count > 200000) return [];
  for (let i = 0; i < count; i += 1) {
    if (offset + 64 > buffer.length) return poses;
    offset += 4;
    const qw = buffer.readDoubleLE(offset);
    const qx = buffer.readDoubleLE(offset + 8);
    const qy = buffer.readDoubleLE(offset + 16);
    const qz = buffer.readDoubleLE(offset + 24);
    const tx = buffer.readDoubleLE(offset + 32);
    const ty = buffer.readDoubleLE(offset + 40);
    const tz = buffer.readDoubleLE(offset + 48);
    const cameraId = buffer.readUInt32LE(offset + 56);
    offset += 56 + 4;
    const nameStart = offset;
    while (offset < buffer.length && buffer[offset] !== 0) offset += 1;
    const name = buffer.toString('utf8', nameStart, offset);
    offset += 1;
    if (offset + 8 > buffer.length) return poses;
    const numPoints = Number(buffer.readBigUInt64LE(offset));
    offset += 8 + numPoints * 24;
    poses.push(poseFromQt(qw, qx, qy, qz, tx, ty, tz, name, cameraId));
  }
  return poses;
}

function parseImagesTxt(text) {
  const poses = [];
  const lines = text.split(/\r?\n/);
  let expectPose = true;
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    if (!expectPose) {
      expectPose = true;
      continue;
    }
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;
    poses.push(poseFromQt(
      Number(parts[1]), Number(parts[2]), Number(parts[3]), Number(parts[4]),
      Number(parts[5]), Number(parts[6]), Number(parts[7]),
      parts[9] || '', Number(parts[8]) || 0,
    ));
    expectPose = false;
  }
  return poses;
}

export async function readCameraPoses(work, { preferDense = false } = {}) {
  const sparse = [
    join(work, 'sparse_txt', 'images.txt'),
    join(work, 'sparse', '0', 'images.txt'),
    join(work, 'sparse', '0', 'images.bin'),
  ];
  const dense = [
    join(work, 'dense', 'sparse', 'images.bin'),
    join(work, 'dense', 'sparse', 'images.txt'),
  ];
  // images.txt carries every 2D observation, so it is tens of megabytes of text
  // for a scene whose poses are a few kilobytes. When only the poses are wanted
  // the binary model under dense/ parses in a fraction of the time.
  const candidates = preferDense ? [...dense, ...sparse] : [...sparse, ...dense];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const buffer = await readFile(path);
      const poses = path.endsWith('.txt')
        ? parseImagesTxt(buffer.toString('utf8'))
        : parseImagesBin(buffer);
      const valid = poses.filter((pose) => pose.center.every(Number.isFinite));
      if (valid.length >= 3) return valid;
    } catch {
      // try the next candidate
    }
  }
  return [];
}

// COLMAP camera models, by the id stored in cameras.bin. Only the parameter
// count and the fx/fy/cx/cy layout matter here: the dense images have already
// been undistorted, so the radial terms are never applied.
const CAMERA_MODELS = {
  0: { name: 'SIMPLE_PINHOLE', params: 3, pick: (p) => ({ fx: p[0], fy: p[0], cx: p[1], cy: p[2] }) },
  1: { name: 'PINHOLE', params: 4, pick: (p) => ({ fx: p[0], fy: p[1], cx: p[2], cy: p[3] }) },
  2: { name: 'SIMPLE_RADIAL', params: 4, pick: (p) => ({ fx: p[0], fy: p[0], cx: p[1], cy: p[2] }) },
  3: { name: 'RADIAL', params: 5, pick: (p) => ({ fx: p[0], fy: p[0], cx: p[1], cy: p[2] }) },
  4: { name: 'OPENCV', params: 8, pick: (p) => ({ fx: p[0], fy: p[1], cx: p[2], cy: p[3] }) },
  5: { name: 'OPENCV_FISHEYE', params: 8, pick: (p) => ({ fx: p[0], fy: p[1], cx: p[2], cy: p[3] }) },
  6: { name: 'FULL_OPENCV', params: 12, pick: (p) => ({ fx: p[0], fy: p[1], cx: p[2], cy: p[3] }) },
  7: { name: 'FOV', params: 5, pick: (p) => ({ fx: p[0], fy: p[1], cx: p[2], cy: p[3] }) },
  8: { name: 'SIMPLE_RADIAL_FISHEYE', params: 4, pick: (p) => ({ fx: p[0], fy: p[0], cx: p[1], cy: p[2] }) },
  9: { name: 'RADIAL_FISHEYE', params: 5, pick: (p) => ({ fx: p[0], fy: p[0], cx: p[1], cy: p[2] }) },
  10: { name: 'THIN_PRISM_FISHEYE', params: 12, pick: (p) => ({ fx: p[0], fy: p[1], cx: p[2], cy: p[3] }) },
};

const MODEL_BY_NAME = Object.fromEntries(
  Object.entries(CAMERA_MODELS).map(([id, model]) => [model.name, { id: Number(id), ...model }]),
);

function parseCamerasBin(buffer) {
  const cameras = new Map();
  let offset = 0;
  const count = Number(buffer.readBigUInt64LE(offset));
  offset += 8;
  if (!Number.isFinite(count) || count <= 0 || count > 100000) return cameras;
  for (let i = 0; i < count; i += 1) {
    if (offset + 24 > buffer.length) break;
    const id = buffer.readUInt32LE(offset);
    const modelId = buffer.readInt32LE(offset + 4);
    const width = Number(buffer.readBigUInt64LE(offset + 8));
    const height = Number(buffer.readBigUInt64LE(offset + 16));
    offset += 24;
    const model = CAMERA_MODELS[modelId];
    if (!model) break;
    const params = [];
    for (let k = 0; k < model.params; k += 1) params.push(buffer.readDoubleLE(offset + k * 8));
    offset += model.params * 8;
    cameras.set(id, { id, model: model.name, width, height, ...model.pick(params) });
  }
  return cameras;
}

function parseCamerasTxt(text) {
  const cameras = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const model = MODEL_BY_NAME[parts[1]];
    if (!model) continue;
    const params = parts.slice(4).map(Number);
    cameras.set(Number(parts[0]), {
      id: Number(parts[0]),
      model: model.name,
      width: Number(parts[2]),
      height: Number(parts[3]),
      ...model.pick(params),
    });
  }
  return cameras;
}

export async function readCameraIntrinsics(work, { dense = true } = {}) {
  const candidates = dense
    ? [
      join(work, 'dense', 'sparse', 'cameras.bin'),
      join(work, 'dense', 'sparse', 'cameras.txt'),
      join(work, 'sparse_txt', 'cameras.txt'),
      join(work, 'sparse', '0', 'cameras.bin'),
    ]
    : [
      join(work, 'sparse_txt', 'cameras.txt'),
      join(work, 'sparse', '0', 'cameras.bin'),
    ];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const buffer = await readFile(path);
      const cameras = path.endsWith('.txt')
        ? parseCamerasTxt(buffer.toString('utf8'))
        : parseCamerasBin(buffer);
      if (cameras.size) return cameras;
    } catch {
      // try the next candidate
    }
  }
  return new Map();
}

/**
 * Poses paired with the undistorted frame each one took, ready for reprojection.
 *
 * The undistorted set is the one that matters: `colmap image_undistorter` crops
 * the frame and refits the focal length, so dense/images is 1280x717 with its
 * own pinhole intrinsics rather than the 1280x720 SIMPLE_RADIAL camera the
 * sparse model was solved with. Reprojecting with the sparse intrinsics would
 * put every sample a pixel and a half out.
 */
export async function readUndistortedViews(work) {
  const imageDir = join(work, 'dense', 'images');
  if (!existsSync(imageDir)) return [];
  const [poses, intrinsics] = await Promise.all([
    readCameraPoses(work, { preferDense: true }),
    readCameraIntrinsics(work),
  ]);
  if (!poses.length || !intrinsics.size) return [];
  const fallback = intrinsics.values().next().value;
  const views = [];
  for (const pose of poses) {
    if (!pose.name) continue;
    const path = join(imageDir, pose.name);
    if (!existsSync(path)) continue;
    const camera = intrinsics.get(pose.cameraId) || fallback;
    views.push({ ...pose, path, ...camera, cameraModel: camera.model });
  }
  return views;
}

/** Jacobi eigendecomposition of a symmetric 3x3 matrix, ascending by eigenvalue. */
function symmetricEigen(m) {
  let a = m.map((row) => [...row]);
  let v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 32; sweep += 1) {
    let off = 0;
    for (let p = 0; p < 3; p += 1) {
      for (let q = p + 1; q < 3; q += 1) off += a[p][q] * a[p][q];
    }
    if (off < 1e-20) break;
    for (let p = 0; p < 3; p += 1) {
      for (let q = p + 1; q < 3; q += 1) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        const next = a.map((row) => [...row]);
        for (let k = 0; k < 3; k += 1) {
          next[p][k] = c * a[p][k] - s * a[q][k];
          next[q][k] = s * a[p][k] + c * a[q][k];
        }
        const rotated = next.map((row) => [...row]);
        for (let k = 0; k < 3; k += 1) {
          rotated[k][p] = c * next[k][p] - s * next[k][q];
          rotated[k][q] = s * next[k][p] + c * next[k][q];
        }
        a = rotated;
        const nv = v.map((row) => [...row]);
        for (let k = 0; k < 3; k += 1) {
          nv[k][p] = c * v[k][p] - s * v[k][q];
          nv[k][q] = s * v[k][p] + c * v[k][q];
        }
        v = nv;
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j]);
  return order.map((i) => ({
    value: a[i][i],
    vector: [v[0][i], v[1][i], v[2][i]],
  }));
}

/**
 * World-space up direction from the solved cameras.
 *
 * A gimballed drone camera holds roll at zero, so its right axis stays
 * horizontal no matter how far the operator pitches down, and the flight line
 * is horizontal too. Gravity is therefore the direction perpendicular to both,
 * recovered as the least-variance eigenvector of those axes. Averaging the
 * camera down-axes instead would tilt the whole model by the pitch angle.
 */
export function gravityUpFromPoses(poses) {
  if (poses.length < 3) return null;
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const accumulate = (axis, weight) => {
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) m[i][j] += weight * axis[i] * axis[j];
    }
  };
  for (const pose of poses) accumulate(pose.rightAxis, 1);

  // The flight line is horizontal as well, and it breaks the tie when the drone
  // never turns enough for the right axes alone to pin gravity down.
  const first = poses[0].center;
  const last = poses[poses.length - 1].center;
  const travel = [last[0] - first[0], last[1] - first[1], last[2] - first[2]];
  const travelLength = Math.hypot(...travel);
  if (travelLength > 1e-6) {
    accumulate(travel.map((value) => value / travelLength), poses.length * 0.5);
  }

  const eigen = symmetricEigen(m);
  const candidate = eigen[0].vector;
  const length = Math.hypot(...candidate);
  if (!(length > 1e-9)) return null;
  const axis = candidate.map((value) => value / length);

  // Eigenvectors have no sign; the mean camera down-axis says which end is up.
  let reference = [0, 0, 0];
  for (const pose of poses) {
    reference = [
      reference[0] - pose.downAxis[0],
      reference[1] - pose.downAxis[1],
      reference[2] - pose.downAxis[2],
    ];
  }
  const dot = axis[0] * reference[0] + axis[1] * reference[1] + axis[2] * reference[2];
  return dot < 0 ? axis.map((value) => -value) : axis;
}

export function flightPathLength(poses) {
  let total = 0;
  for (let i = 1; i < poses.length; i += 1) {
    total += Math.hypot(
      poses[i].center[0] - poses[i - 1].center[0],
      poses[i].center[1] - poses[i - 1].center[1],
      poses[i].center[2] - poses[i - 1].center[2],
    );
  }
  return total;
}
