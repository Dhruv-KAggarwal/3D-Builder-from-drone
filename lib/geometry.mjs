import { encodePng } from './png.mjs';

export function centroid(positions) {
  const n = positions.length / 3;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < positions.length; i += 3) {
    x += positions[i];
    y += positions[i + 1];
    z += positions[i + 2];
  }
  return [x / n, y / n, z / n];
}

export function boundsOf(positions) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]);
    minY = Math.min(minY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]);
    maxX = Math.max(maxX, positions[i]);
    maxY = Math.max(maxY, positions[i + 1]);
    maxZ = Math.max(maxZ, positions[i + 2]);
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function eigenLargest(cov, start = [0.21, 0.67, 0.41]) {
  let v = start;
  for (let iter = 0; iter < 32; iter += 1) {
    const nx = cov[0][0] * v[0] + cov[0][1] * v[1] + cov[0][2] * v[2];
    const ny = cov[1][0] * v[0] + cov[1][1] * v[1] + cov[1][2] * v[2];
    const nz = cov[2][0] * v[0] + cov[2][1] * v[1] + cov[2][2] * v[2];
    const length = Math.hypot(nx, ny, nz) || 1;
    v = [nx / length, ny / length, nz / length];
  }
  const lambda = cov[0][0] * v[0] + cov[0][1] * v[1] + cov[0][2] * v[2];
  return { vector: v, lambda };
}

function deflate(cov, vector, lambda) {
  const next = cov.map((row) => row.slice());
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) next[r][c] -= lambda * vector[r] * vector[c];
  }
  return next;
}

export function pcaUp(positions) {
  const c = centroid(positions);
  let xx = 0;
  let xy = 0;
  let xz = 0;
  let yy = 0;
  let yz = 0;
  let zz = 0;
  const n = positions.length / 3;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - c[0];
    const dy = positions[i + 1] - c[1];
    const dz = positions[i + 2] - c[2];
    xx += dx * dx;
    xy += dx * dy;
    xz += dx * dz;
    yy += dy * dy;
    yz += dy * dz;
    zz += dz * dz;
  }
  const cov = [
    [xx / n, xy / n, xz / n],
    [xy / n, yy / n, yz / n],
    [xz / n, yz / n, zz / n],
  ];
  const first = eigenLargest(cov);
  const second = eigenLargest(deflate(cov, first.vector, first.lambda), [0.7, 0.1, 0.68]);
  const v3 = [
    first.vector[1] * second.vector[2] - first.vector[2] * second.vector[1],
    first.vector[2] * second.vector[0] - first.vector[0] * second.vector[2],
    first.vector[0] * second.vector[1] - first.vector[1] * second.vector[0],
  ];
  const len = Math.hypot(...v3) || 1;
  const third = { vector: v3.map((value) => value / len), lambda: cov[0][0] * (v3[0] / len) + cov[0][1] * (v3[1] / len) + cov[0][2] * (v3[2] / len) };
  const axes = [first, second, third].sort((a, b) => a.lambda - b.lambda);
  const up = axes[0].vector;
  return up[1] < 0 ? up.map((value) => -value) : up;
}

export function rotationToYUp(up) {
  const to = [0, 1, 0];
  if (!up || !up.every(Number.isFinite) || Math.hypot(...up) < 1e-6) {
    return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  }
  const cos = up[0] * to[0] + up[1] * to[1] + up[2] * to[2];
  if (cos > 0.9999) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  if (cos < -0.9999) return [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
  const vx = up[1] * to[2] - up[2] * to[1];
  const vy = up[2] * to[0] - up[0] * to[2];
  const vz = up[0] * to[1] - up[1] * to[0];
  const skew = [[0, -vz, vy], [vz, 0, -vx], [-vy, vx, 0]];
  const skew2 = [
    [-(vz * vz + vy * vy), vx * vy, vx * vz],
    [vx * vy, -(vz * vz + vx * vx), vy * vz],
    [vx * vz, vy * vz, -(vy * vy + vx * vx)],
  ];
  const coeff = (1 - cos) / (vx * vx + vy * vy + vz * vz);
  const rotation = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 3; c += 1) rotation[r][c] += skew[r][c] + skew2[r][c] * coeff;
  }
  return rotation;
}

export function applyRotation(positions, rotation, origin) {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i] - origin[0];
    const y = positions[i + 1] - origin[1];
    const z = positions[i + 2] - origin[2];
    out[i] = rotation[0][0] * x + rotation[0][1] * y + rotation[0][2] * z;
    out[i + 1] = rotation[1][0] * x + rotation[1][1] * y + rotation[1][2] * z;
    out[i + 2] = rotation[2][0] * x + rotation[2][1] * y + rotation[2][2] * z;
  }
  return out;
}

export function scalePositions(positions, scale) {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 1) out[i] = positions[i] * scale;
  return out;
}

export function isSkyColor(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  return b > 150 && b > r + 18 && b > g + 10 && sat > 0.14 && g > 110;
}

export function compactCloud(positions, colors, normals) {
  const finite = [];
  const finiteColors = colors ? [] : null;
  const finiteNormals = normals ? [] : null;
  for (let i = 0; i < positions.length / 3; i += 1) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (colors && isSkyColor(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2])) continue;
    finite.push(x, y, z);
    if (finiteColors) finiteColors.push(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
    if (finiteNormals) finiteNormals.push(normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]);
  }
  return {
    positions: new Float32Array(finite),
    colors: finiteColors ? new Uint8Array(finiteColors) : null,
    normals: finiteNormals ? new Float32Array(finiteNormals) : null,
    vertexCount: finite.length / 3,
  };
}

function axisPercentile(positions, axis, fraction) {
  const n = positions.length / 3;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i += 1) values[i] = positions[i * 3 + axis];
  values.sort();
  const index = Math.max(0, Math.min(n - 1, Math.floor(fraction * (n - 1))));
  return values[index];
}

export function clipHorizontalOutliers(positions, colors, lo = 0.012, hi = 0.988) {
  const minX = axisPercentile(positions, 0, lo);
  const maxX = axisPercentile(positions, 0, hi);
  const minZ = axisPercentile(positions, 2, lo);
  const maxZ = axisPercentile(positions, 2, hi);
  const nextPos = [];
  const nextCol = colors ? [] : null;
  for (let i = 0; i < positions.length / 3; i += 1) {
    const x = positions[i * 3];
    const z = positions[i * 3 + 2];
    if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
    nextPos.push(x, positions[i * 3 + 1], z);
    if (nextCol) nextCol.push(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
  }
  if (nextPos.length < 300) return { positions, colors };
  return { positions: new Float32Array(nextPos), colors: nextCol ? new Uint8Array(nextCol) : null };
}

export function densityFilter(positions, colors, resolution = 96, minCount = 4) {
  const box = boundsOf(positions);
  const spanX = Math.max(1e-6, box.max[0] - box.min[0]);
  const spanY = Math.max(1e-6, box.max[1] - box.min[1]);
  const spanZ = Math.max(1e-6, box.max[2] - box.min[2]);
  const counts = new Uint16Array(resolution * resolution * resolution);
  const count = positions.length / 3;
  const cells = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) {
    const ix = Math.min(resolution - 1, Math.max(0, Math.floor(((positions[i * 3] - box.min[0]) / spanX) * (resolution - 1))));
    const iy = Math.min(resolution - 1, Math.max(0, Math.floor(((positions[i * 3 + 1] - box.min[1]) / spanY) * (resolution - 1))));
    const iz = Math.min(resolution - 1, Math.max(0, Math.floor(((positions[i * 3 + 2] - box.min[2]) / spanZ) * (resolution - 1))));
    const cell = ix + iy * resolution + iz * resolution * resolution;
    cells[i] = cell;
    counts[cell] = Math.min(65535, counts[cell] + 1);
  }
  const nextPos = [];
  const nextCol = colors ? [] : null;
  for (let i = 0; i < count; i += 1) {
    if (counts[cells[i]] < minCount) continue;
    nextPos.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    if (nextCol) nextCol.push(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
  }
  if (nextPos.length < 300) return { positions, colors };
  return { positions: new Float32Array(nextPos), colors: nextCol ? new Uint8Array(nextCol) : null };
}

export function subsampleCloud(positions, colors, maxPoints = 220000) {
  const count = positions.length / 3;
  if (count <= maxPoints) return { positions, colors };
  const step = count / maxPoints;
  const nextPos = new Float32Array(maxPoints * 3);
  const nextCol = colors ? new Uint8Array(maxPoints * 3) : null;
  for (let i = 0; i < maxPoints; i += 1) {
    const index = Math.min(count - 1, Math.floor(i * step));
    nextPos[i * 3] = positions[index * 3];
    nextPos[i * 3 + 1] = positions[index * 3 + 1];
    nextPos[i * 3 + 2] = positions[index * 3 + 2];
    if (nextCol) {
      nextCol[i * 3] = colors[index * 3];
      nextCol[i * 3 + 1] = colors[index * 3 + 1];
      nextCol[i * 3 + 2] = colors[index * 3 + 2];
    }
  }
  return { positions: nextPos, colors: nextCol };
}

export function transferColors(meshPositions, cloudPositions, cloudColors) {
  const colors = new Uint8Array(meshPositions.length);
  if (!cloudColors) {
    colors.fill(160);
    return colors;
  }
  const box = boundsOf(cloudPositions);
  const spanX = Math.max(1e-6, box.max[0] - box.min[0]);
  const spanZ = Math.max(1e-6, box.max[2] - box.min[2]);
  const res = 384;
  const rSum = new Float32Array(res * res);
  const gSum = new Float32Array(res * res);
  const bSum = new Float32Array(res * res);
  const nSum = new Uint32Array(res * res);
  for (let i = 0; i < cloudPositions.length / 3; i += 1) {
    const cx = Math.max(0, Math.min(res - 1, Math.floor((cloudPositions[i * 3] - box.min[0]) / spanX * (res - 1))));
    const cz = Math.max(0, Math.min(res - 1, Math.floor((cloudPositions[i * 3 + 2] - box.min[2]) / spanZ * (res - 1))));
    const key = cz * res + cx;
    rSum[key] += cloudColors[i * 3];
    gSum[key] += cloudColors[i * 3 + 1];
    bSum[key] += cloudColors[i * 3 + 2];
    nSum[key] += 1;
  }
  for (let i = 0; i < meshPositions.length / 3; i += 1) {
    const x = meshPositions[i * 3];
    const z = meshPositions[i * 3 + 2];
    const cx = Math.max(0, Math.min(res - 1, Math.floor((x - box.min[0]) / spanX * (res - 1))));
    const cz = Math.max(0, Math.min(res - 1, Math.floor((z - box.min[2]) / spanZ * (res - 1))));
    let best = -1;
    for (let dz = -2; dz <= 2 && best < 0; dz += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < 0 || nz < 0 || nx >= res || nz >= res) continue;
        const key = nz * res + nx;
        if (nSum[key]) {
          best = key;
          break;
        }
      }
    }
    if (best >= 0) {
      const n = nSum[best];
      colors[i * 3] = Math.round(rSum[best] / n);
      colors[i * 3 + 1] = Math.round(gSum[best] / n);
      colors[i * 3 + 2] = Math.round(bSum[best] / n);
    } else {
      colors[i * 3] = 112;
      colors[i * 3 + 1] = 124;
      colors[i * 3 + 2] = 96;
    }
  }
  return colors;
}

export function computeNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    normals[a] += nx;
    normals[a + 1] += ny;
    normals[a + 2] += nz;
    normals[b] += nx;
    normals[b + 1] += ny;
    normals[b + 2] += nz;
    normals[c] += nx;
    normals[c + 1] += ny;
    normals[c + 2] += nz;
  }
  for (let i = 0; i < normals.length; i += 3) {
    const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= length;
    normals[i + 1] /= length;
    normals[i + 2] /= length;
  }
  return normals;
}

export function applyHillshade(positions, colors, indices) {
  const normals = computeNormals(positions, indices);
  const box = boundsOf(positions);
  const spanY = Math.max(1e-6, box.max[1] - box.min[1]);
  const sun = [0.42, 0.78, 0.46];
  const slen = Math.hypot(...sun);
  const sx = sun[0] / slen;
  const sy = sun[1] / slen;
  const sz = sun[2] / slen;
  const out = new Uint8Array(positions.length);
  for (let i = 0; i < positions.length / 3; i += 1) {
    const shade = 0.28 + 0.72 * Math.max(0, normals[i * 3] * sx + normals[i * 3 + 1] * sy + normals[i * 3 + 2] * sz);
    const elev = 0.82 + 0.18 * ((positions[i * 3 + 1] - box.min[1]) / spanY);
    const light = shade * elev;
    const r = colors ? colors[i * 3] : 142;
    const g = colors ? colors[i * 3 + 1] : 148;
    const b = colors ? colors[i * 3 + 2] : 128;
    out[i * 3] = Math.min(255, Math.round(r * light));
    out[i * 3 + 1] = Math.min(255, Math.round(g * light));
    out[i * 3 + 2] = Math.min(255, Math.round(b * light));
  }
  return out;
}

export function voxelSimplify(positions, colors, indices, targetFaces = 360000) {
  const faceCount = indices.length / 3;
  if (faceCount <= targetFaces) {
    return { positions, colors, indices };
  }
  const box = boundsOf(positions);
  const spanX = Math.max(1e-6, box.max[0] - box.min[0]);
  const spanZ = Math.max(1e-6, box.max[2] - box.min[2]);
  const horiz = Math.max(spanX, spanZ);
  const res = Math.max(160, Math.min(520, Math.round(Math.sqrt(targetFaces * 0.7))));
  const cellSize = horiz / res;
  const occupied = new Map();
  const remap = new Uint32Array(positions.length / 3);
  for (let i = 0; i < positions.length / 3; i += 1) {
    const ix = Math.floor((positions[i * 3] - box.min[0]) / cellSize);
    const iy = Math.floor((positions[i * 3 + 1] - box.min[1]) / cellSize);
    const iz = Math.floor((positions[i * 3 + 2] - box.min[2]) / cellSize);
    const key = `${ix},${iy},${iz}`;
    let cell = occupied.get(key);
    if (!cell) {
      cell = { x: 0, y: 0, z: 0, r: 0, g: 0, b: 0, n: 0, id: occupied.size };
      occupied.set(key, cell);
    }
    cell.x += positions[i * 3];
    cell.y += positions[i * 3 + 1];
    cell.z += positions[i * 3 + 2];
    if (colors) {
      cell.r += colors[i * 3];
      cell.g += colors[i * 3 + 1];
      cell.b += colors[i * 3 + 2];
    }
    cell.n += 1;
    remap[i] = cell.id;
  }
  const nextPos = new Float32Array(occupied.size * 3);
  const nextCol = new Uint8Array(occupied.size * 3);
  for (const cell of occupied.values()) {
    const i = cell.id * 3;
    nextPos[i] = cell.x / cell.n;
    nextPos[i + 1] = cell.y / cell.n;
    nextPos[i + 2] = cell.z / cell.n;
    nextCol[i] = colors ? Math.round(cell.r / cell.n) : 140;
    nextCol[i + 1] = colors ? Math.round(cell.g / cell.n) : 146;
    nextCol[i + 2] = colors ? Math.round(cell.b / cell.n) : 128;
  }
  const nextIdx = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = remap[indices[i]];
    const b = remap[indices[i + 1]];
    const c = remap[indices[i + 2]];
    if (a === b || b === c || c === a) continue;
    nextIdx.push(a, b, c);
  }
  return {
    positions: nextPos,
    colors: nextCol,
    indices: new Uint32Array(nextIdx),
  };
}

export function buildHeightmap(positions, colors, resolution = 512) {
  const box = boundsOf(positions);
  if (!Number.isFinite(box.min[0]) || !Number.isFinite(box.max[0])) {
    throw new Error('Point cloud contains invalid coordinates.');
  }
  const spanX = Math.max(1e-6, box.max[0] - box.min[0]);
  const spanZ = Math.max(1e-6, box.max[2] - box.min[2]);
  const cols = Math.max(48, Math.round(resolution));
  const rows = Math.max(48, Math.round(resolution * (spanZ / spanX)));
  const height = new Float32Array(cols * rows);
  const weight = new Float32Array(cols * rows);
  const rgb = new Float32Array(cols * rows * 3);

  for (let i = 0; i < positions.length; i += 3) {
    const u = (positions[i] - box.min[0]) / spanX;
    const v = (positions[i + 2] - box.min[2]) / spanZ;
    const x = Math.min(cols - 1, Math.max(0, Math.floor(u * (cols - 1))));
    const y = Math.min(rows - 1, Math.max(0, Math.floor(v * (rows - 1))));
    const index = y * cols + x;
    height[index] += positions[i + 1];
    weight[index] += 1;
    if (colors) {
      rgb[index * 3] += colors[i];
      rgb[index * 3 + 1] += colors[i + 1];
      rgb[index * 3 + 2] += colors[i + 2];
    }
  }

  for (let i = 0; i < height.length; i += 1) {
    if (weight[i] > 0) {
      height[i] /= weight[i];
      rgb[i * 3] /= weight[i];
      rgb[i * 3 + 1] /= weight[i];
      rgb[i * 3 + 2] /= weight[i];
    } else height[i] = Number.NaN;
  }

  for (let pass = 0; pass < 5; pass += 1) {
    const next = height.slice();
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const index = y * cols + x;
        if (!Number.isNaN(height[index])) continue;
        let sum = 0;
        let count = 0;
        let cr = 0;
        let cg = 0;
        let cb = 0;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const ni = ny * cols + nx;
            if (Number.isNaN(height[ni])) continue;
            sum += height[ni];
            count += 1;
            cr += rgb[ni * 3];
            cg += rgb[ni * 3 + 1];
            cb += rgb[ni * 3 + 2];
          }
        }
        if (count >= 3) {
          next[index] = sum / count;
          rgb[index * 3] = cr / count;
          rgb[index * 3 + 1] = cg / count;
          rgb[index * 3 + 2] = cb / count;
        }
      }
    }
    height.set(next);
  }

  const meshPositions = [];
  const meshColors = [];
  const meshUvs = [];
  const indices = [];
  const vertexIndex = new Int32Array(cols * rows).fill(-1);
  let vertexCount = 0;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const index = y * cols + x;
      if (Number.isNaN(height[index])) continue;
      vertexIndex[index] = vertexCount;
      vertexCount += 1;
      meshPositions.push(
        box.min[0] + (x / (cols - 1)) * spanX,
        height[index],
        box.min[2] + (y / (rows - 1)) * spanZ,
      );
      meshColors.push(rgb[index * 3] || 110, rgb[index * 3 + 1] || 120, rgb[index * 3 + 2] || 90);
      meshUvs.push(x / (cols - 1), 1 - y / (rows - 1));
    }
  }
  for (let y = 0; y < rows - 1; y += 1) {
    for (let x = 0; x < cols - 1; x += 1) {
      const a = vertexIndex[y * cols + x];
      const b = vertexIndex[y * cols + x + 1];
      const c = vertexIndex[(y + 1) * cols + x];
      const d = vertexIndex[(y + 1) * cols + x + 1];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      indices.push(a, c, b, b, c, d);
    }
  }

  const tex = Buffer.alloc(cols * rows * 3);
  for (let i = 0; i < cols * rows; i += 1) {
    const empty = Number.isNaN(height[i]);
    tex[i * 3] = empty ? 18 : Math.max(0, Math.min(255, Math.round(rgb[i * 3] || 90)));
    tex[i * 3 + 1] = empty ? 28 : Math.max(0, Math.min(255, Math.round(rgb[i * 3 + 1] || 100)));
    tex[i * 3 + 2] = empty ? 32 : Math.max(0, Math.min(255, Math.round(rgb[i * 3 + 2] || 90)));
  }

  return {
    positions: new Float32Array(meshPositions),
    colors: new Uint8Array(meshColors),
    uvs: new Float32Array(meshUvs),
    indices: new Uint32Array(indices),
    ortho: encodePng(tex, cols, rows),
    resolution: { cols, rows },
    filled: vertexCount,
  };
}

export function classifyCoverage(positions, colors) {
  const layers = { terrain: 0, vegetation: 0, highland: 0, water: 0 };
  const box = boundsOf(positions);
  const spanY = Math.max(1e-6, box.max[1] - box.min[1]);
  const count = positions.length / 3;
  for (let i = 0; i < count; i += 1) {
    const r = colors ? colors[i * 3] : 120;
    const g = colors ? colors[i * 3 + 1] : 120;
    const b = colors ? colors[i * 3 + 2] : 120;
    const h = (positions[i * 3 + 1] - box.min[1]) / spanY;
    if (b > r + 12 && b > g + 8 && b > 90 && h < 0.35) layers.water += 1;
    else if (g > r + 10 && g > b + 6 && g > 70) layers.vegetation += 1;
    else if (h > 0.7) layers.highland += 1;
    else layers.terrain += 1;
  }
  return layers;
}

export function makeUvs(positions) {
  const box = boundsOf(positions);
  const spanX = Math.max(1e-6, box.max[0] - box.min[0]);
  const spanZ = Math.max(1e-6, box.max[2] - box.min[2]);
  const uvs = new Float32Array((positions.length / 3) * 2);
  for (let i = 0; i < positions.length / 3; i += 1) {
    uvs[i * 2] = (positions[i * 3] - box.min[0]) / spanX;
    uvs[i * 2 + 1] = 1 - (positions[i * 3 + 2] - box.min[2]) / spanZ;
  }
  return uvs;
}
