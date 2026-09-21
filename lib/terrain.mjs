import { encodePng } from './png.mjs';
import { boundsOf, computeNormals } from './geometry.mjs';

const EMPTY = Number.NaN;

function percentile(sorted, fraction) {
  if (!sorted.length) return Number.NaN;
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round(fraction * (sorted.length - 1))));
  return sorted[index];
}

function axisPercentile(positions, axis, fraction) {
  const n = positions.length / 3;
  const values = new Float64Array(n);
  for (let i = 0; i < n; i += 1) values[i] = positions[i * 3 + axis];
  values.sort();
  return percentile(values, fraction);
}

/**
 * Drops the long thin tails a forward-looking pass leaves behind the camera and
 * far past the horizon, which otherwise stretch the grid over empty space.
 */
export function trimFootprint(positions, colors, keep = 0.985) {
  const lo = (1 - keep) / 2;
  const hi = 1 - lo;
  const minX = axisPercentile(positions, 0, lo);
  const maxX = axisPercentile(positions, 0, hi);
  const minZ = axisPercentile(positions, 2, lo);
  const maxZ = axisPercentile(positions, 2, hi);
  const minY = axisPercentile(positions, 1, 0.002);
  const maxY = axisPercentile(positions, 1, 0.998);
  const nextPos = [];
  const nextCol = colors ? [] : null;
  for (let i = 0; i < positions.length / 3; i += 1) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x < minX || x > maxX || z < minZ || z > maxZ || y < minY || y > maxY) continue;
    nextPos.push(x, y, z);
    if (nextCol) nextCol.push(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
  }
  if (nextPos.length < 900) return { positions, colors };
  return { positions: new Float32Array(nextPos), colors: nextCol ? new Uint8Array(nextCol) : null };
}

/**
 * Discards points lying far off the flight line before the grid is sized. A few
 * stragglers on the horizon would otherwise inflate the bounding box and spend
 * most of the grid resolution on empty space.
 */
export function clipToCameraRange(positions, colors, cameraXZ, keepFraction = 0.94) {
  if (!cameraXZ?.length) return { positions, colors };
  const count = positions.length / 3;
  const distances = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const x = positions[i * 3];
    const z = positions[i * 3 + 2];
    let best = Infinity;
    for (const camera of cameraXZ) {
      const dx = x - camera[0];
      const dz = z - camera[1];
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    distances[i] = best;
  }
  const sorted = Float32Array.from(distances).sort();
  const cutoff = sorted[Math.min(count - 1, Math.floor(keepFraction * (count - 1)))];
  const keptPos = [];
  const keptCol = colors ? [] : null;
  for (let i = 0; i < count; i += 1) {
    if (distances[i] > cutoff) continue;
    keptPos.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    if (keptCol) keptCol.push(colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]);
  }
  if (keptPos.length < 3000) return { positions, colors };
  return {
    positions: new Float32Array(keptPos),
    colors: keptCol ? new Uint8Array(keptCol) : null,
  };
}

function gridIndexer(box, cols, rows) {
  const spanX = Math.max(1e-6, box.max[0] - box.min[0]);
  const spanZ = Math.max(1e-6, box.max[2] - box.min[2]);
  return (x, z) => {
    const cx = Math.min(cols - 1, Math.max(0, Math.floor(((x - box.min[0]) / spanX) * (cols - 1))));
    const cz = Math.min(rows - 1, Math.max(0, Math.floor(((z - box.min[2]) / spanZ) * (rows - 1))));
    return cz * cols + cx;
  };
}

/**
 * Bins the cloud into a 2.5D grid and keeps the median height per cell. The
 * median rejects the reprojection floaters that sit above real ground, which a
 * mean would smear into spikes.
 */
function rasterizeSurface(positions, colors, box, cols, rows, cellSize) {
  const cells = cols * rows;
  const indexOf = gridIndexer(box, cols, rows);
  const counts = new Uint32Array(cells);
  const count = positions.length / 3;
  const cellOf = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) {
    const cell = indexOf(positions[i * 3], positions[i * 3 + 2]);
    cellOf[i] = cell;
    counts[cell] += 1;
  }
  const offsets = new Uint32Array(cells + 1);
  for (let i = 0; i < cells; i += 1) offsets[i + 1] = offsets[i] + counts[i];
  const cursor = offsets.slice(0, cells);
  const heights = new Float32Array(count);
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) {
    const slot = cursor[cellOf[i]];
    cursor[cellOf[i]] = slot + 1;
    heights[slot] = positions[i * 3 + 1];
    order[slot] = i;
  }

  const height = new Float32Array(cells).fill(EMPTY);
  const rgb = new Float32Array(cells * 3);
  const sampleCount = new Uint32Array(cells);
  const confidence = new Float32Array(cells);
  // A genuine patch of ground inside one cell cannot span much more than the
  // cell is wide. Anything beyond that is a near-vertical face or depth noise,
  // and either way the single height this cell can store is unreliable.
  const maxSlab = Math.max(1e-6, cellSize * 2.5);
  const BINS = 24;
  const histogram = new Uint32Array(BINS);
  for (let cell = 0; cell < cells; cell += 1) {
    const start = offsets[cell];
    const end = offsets[cell + 1];
    const total = end - start;
    if (total === 0) continue;

    // A single XZ column can hold both real surface and a tail of depth-map
    // outliers. The densest vertical bin is the surface; a median would sit
    // between the two clusters and carve a spike.
    let lo = Infinity;
    let hi = -Infinity;
    for (let s = start; s < end; s += 1) {
      if (heights[s] < lo) lo = heights[s];
      if (heights[s] > hi) hi = heights[s];
    }
    const span = hi - lo;
    let centre;
    let tolerance;
    if (total < 4 || span < 1e-6) {
      centre = (lo + hi) / 2;
      tolerance = Math.max(span, 1e-6);
    } else {
      histogram.fill(0);
      const binSize = span / BINS;
      for (let s = start; s < end; s += 1) {
        const bin = Math.min(BINS - 1, Math.floor((heights[s] - lo) / binSize));
        histogram[bin] += 1;
      }
      let bestBin = 0;
      let bestScore = -1;
      for (let b = 0; b < BINS; b += 1) {
        const score = histogram[b] + (histogram[b - 1] || 0) + (histogram[b + 1] || 0);
        if (score > bestScore) {
          bestScore = score;
          bestBin = b;
        }
      }
      centre = lo + (bestBin + 0.5) * binSize;
      tolerance = Math.min(binSize * 1.5, maxSlab);
    }

    let sum = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let s = start; s < end; s += 1) {
      if (Math.abs(heights[s] - centre) > tolerance) continue;
      sum += heights[s];
      const point = order[s];
      if (colors) {
        r += colors[point * 3];
        g += colors[point * 3 + 1];
        b += colors[point * 3 + 2];
      }
      n += 1;
    }
    if (n === 0) continue;
    height[cell] = sum / n;
    rgb[cell * 3] = colors ? r / n : 140;
    rgb[cell * 3 + 1] = colors ? g / n : 146;
    rgb[cell * 3 + 2] = colors ? b / n : 128;
    sampleCount[cell] = n;
    // Confidence combines how many samples agreed on one height with how much
    // of the column they represent. A vertical face packs plenty of points into
    // a cell but only a fraction agree, so it scores low and gets smoothed.
    const agreement = n / total;
    confidence[cell] = Math.min(1, n / 10) * agreement * agreement;
  }
  return { height, rgb, sampleCount, confidence };
}

/**
 * Thinly-sampled cells are noise about as often as surface. Support is pooled
 * over each cell's neighbourhood rather than judged cell by cell: a thin cell
 * inside a well-observed patch is real and worth keeping, while the same cell
 * standing alone in the far field is speckle. A per-cell test cannot tell those
 * apart and shreds otherwise solid ground.
 */
function gateBySupport(height, sampleCount, confidence, cols, rows, budget) {
  const pooled = new Float64Array(cols * rows);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const ni = ny * cols + nx;
          sum += sampleCount[ni] * confidence[ni];
        }
      }
      pooled[y * cols + x] = sum;
    }
  }

  const ladder = [220, 160, 110, 70, 45, 28, 16, 9, 4, 1.5];
  // Falling back to the gentlest threshold rather than to zero matters: a budget
  // that no threshold can reach must still trim the fringe, not disable itself.
  let chosen = ladder[ladder.length - 1];
  for (const threshold of ladder) {
    let kept = 0;
    for (let i = 0; i < pooled.length; i += 1) {
      if (sampleCount[i] > 0 && pooled[i] >= threshold) kept += 1;
    }
    if (kept >= budget) {
      chosen = threshold;
      break;
    }
  }
  for (let i = 0; i < height.length; i += 1) {
    if (sampleCount[i] > 0 && pooled[i] < chosen) {
      height[i] = EMPTY;
      sampleCount[i] = 0;
    }
  }
  return chosen;
}

/**
 * Removes the stalactite spikes left by depth-map outliers. A median filter is
 * used rather than a blur because it erases isolated spikes while leaving real
 * ridge lines and cliff edges intact.
 */
function despike(height, sampleCount, cols, rows, tolerance, passes = 2) {
  const neighbours = [];
  let removed = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    const flagged = [];
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const i = y * cols + x;
        if (Number.isNaN(height[i])) continue;
        neighbours.length = 0;
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) {
            if (!dx && !dy) continue;
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const ni = ny * cols + nx;
            if (Number.isNaN(height[ni])) continue;
            neighbours.push(height[ni]);
          }
        }
        if (neighbours.length < 6) continue;
        neighbours.sort((a, b) => a - b);
        const median = percentile(neighbours, 0.5);
        const spread = Math.max(
          tolerance,
          (percentile(neighbours, 0.75) - percentile(neighbours, 0.25)) * 2.5,
        );
        if (Math.abs(height[i] - median) > spread) flagged.push(i);
      }
    }
    if (!flagged.length) break;
    for (const i of flagged) {
      height[i] = EMPTY;
      sampleCount[i] = 0;
    }
    removed += flagged.length;
  }
  return removed;
}

/**
 * Fills gaps using a coarse-to-fine image pyramid so wide holes converge to the
 * surrounding relief instead of the flat plane a single blur pass would give.
 */
function pyramidFill(height, rgb, cols, rows, maxDistance) {
  const levels = [{ height, rgb, cols, rows }];
  let currentH = height;
  let currentC = rgb;
  let w = cols;
  let h = rows;
  while (w > 8 && h > 8) {
    const nw = Math.ceil(w / 2);
    const nh = Math.ceil(h / 2);
    const nextH = new Float32Array(nw * nh).fill(EMPTY);
    const nextC = new Float32Array(nw * nh * 3);
    for (let y = 0; y < nh; y += 1) {
      for (let x = 0; x < nw; x += 1) {
        let sum = 0;
        let n = 0;
        let cr = 0;
        let cg = 0;
        let cb = 0;
        for (let dy = 0; dy < 2; dy += 1) {
          for (let dx = 0; dx < 2; dx += 1) {
            const sx = x * 2 + dx;
            const sy = y * 2 + dy;
            if (sx >= w || sy >= h) continue;
            const si = sy * w + sx;
            if (Number.isNaN(currentH[si])) continue;
            sum += currentH[si];
            cr += currentC[si * 3];
            cg += currentC[si * 3 + 1];
            cb += currentC[si * 3 + 2];
            n += 1;
          }
        }
        if (n > 0) {
          const di = y * nw + x;
          nextH[di] = sum / n;
          nextC[di * 3] = cr / n;
          nextC[di * 3 + 1] = cg / n;
          nextC[di * 3 + 2] = cb / n;
        }
      }
    }
    levels.push({ height: nextH, rgb: nextC, cols: nw, rows: nh });
    currentH = nextH;
    currentC = nextC;
    w = nw;
    h = nh;
  }

  // Bilinear upsampling matters here: nearest-neighbour copies leave blocky
  // plateaus whose edges become vertical walls once the grid is triangulated.
  const sampleCoarse = (coarse, fx, fy) => {
    const gx = Math.min(coarse.cols - 1, Math.max(0, (fx - 0.5) / 2));
    const gy = Math.min(coarse.rows - 1, Math.max(0, (fy - 0.5) / 2));
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(coarse.cols - 1, x0 + 1);
    const y1 = Math.min(coarse.rows - 1, y0 + 1);
    const tx = gx - x0;
    const ty = gy - y0;
    let sum = 0;
    let weight = 0;
    const rgbSum = [0, 0, 0];
    for (const [px, py, w] of [
      [x0, y0, (1 - tx) * (1 - ty)],
      [x1, y0, tx * (1 - ty)],
      [x0, y1, (1 - tx) * ty],
      [x1, y1, tx * ty],
    ]) {
      const ci = py * coarse.cols + px;
      if (Number.isNaN(coarse.height[ci]) || w <= 0) continue;
      sum += coarse.height[ci] * w;
      rgbSum[0] += coarse.rgb[ci * 3] * w;
      rgbSum[1] += coarse.rgb[ci * 3 + 1] * w;
      rgbSum[2] += coarse.rgb[ci * 3 + 2] * w;
      weight += w;
    }
    if (weight <= 0) return null;
    return { height: sum / weight, rgb: rgbSum.map((v) => v / weight) };
  };

  for (let level = levels.length - 2; level >= 0; level -= 1) {
    const fine = levels[level];
    const coarse = levels[level + 1];
    for (let y = 0; y < fine.rows; y += 1) {
      for (let x = 0; x < fine.cols; x += 1) {
        const fi = y * fine.cols + x;
        if (!Number.isNaN(fine.height[fi])) continue;
        const sampled = sampleCoarse(coarse, x, y);
        if (!sampled) continue;
        fine.height[fi] = sampled.height;
        fine.rgb[fi * 3] = sampled.rgb[0];
        fine.rgb[fi * 3 + 1] = sampled.rgb[1];
        fine.rgb[fi * 3 + 2] = sampled.rgb[2];
      }
    }
  }
  return maxDistance;
}

/**
 * Harmonic (Laplace) relaxation over the interpolated cells only. Measured
 * cells stay pinned, so holes converge to a smooth membrane stretched between
 * the real observations instead of the pyramid's stair-stepped guess.
 */
function relaxFilled(height, sampleCount, mask, cols, rows, iterations) {
  const next = height.slice();
  for (let pass = 0; pass < iterations; pass += 1) {
    let moved = 0;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const i = y * cols + x;
        if (!mask[i] || sampleCount[i] > 0 || Number.isNaN(height[i])) continue;
        let sum = 0;
        let count = 0;
        for (let d = 0; d < 4; d += 1) {
          const nx = x + [1, -1, 0, 0][d];
          const ny = y + [0, 0, 1, -1][d];
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const h = height[ny * cols + nx];
          if (Number.isNaN(h)) continue;
          sum += h;
          count += 1;
        }
        if (count === 0) continue;
        const value = sum / count;
        if (Math.abs(value - height[i]) > 1e-7) moved += 1;
        next[i] = value;
      }
    }
    height.set(next);
    if (!moved) break;
  }
}

/**
 * Clamps the step between neighbouring cells to a plausible ground slope. This
 * is what actually kills the stalactite curtains: a spike can only ever sit one
 * cell-step away from its neighbours, so repeated passes pull it back onto the
 * surface while broad ridges and real cliffs survive.
 */
function limitSlope(height, cols, rows, maxStep, passes = 8) {
  let clamped = 0;
  for (let pass = 0; pass < passes; pass += 1) {
    let changed = 0;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const i = y * cols + x;
        if (Number.isNaN(height[i])) continue;
        let lowest = Infinity;
        let highest = -Infinity;
        for (let d = 0; d < 4; d += 1) {
          const nx = x + [1, -1, 0, 0][d];
          const ny = y + [0, 0, 1, -1][d];
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const h = height[ny * cols + nx];
          if (Number.isNaN(h)) continue;
          if (h < lowest) lowest = h;
          if (h > highest) highest = h;
        }
        if (!Number.isFinite(lowest)) continue;
        if (height[i] > highest + maxStep) {
          height[i] = highest + maxStep;
          changed += 1;
        } else if (height[i] < lowest - maxStep) {
          height[i] = lowest - maxStep;
          changed += 1;
        }
      }
    }
    clamped += changed;
    if (!changed) break;
  }
  return clamped;
}

/**
 * Peels the outermost ring off the surface. Those cells are pure interpolation
 * with measured ground on one side only, so they tend to stick out as thin fins
 * rather than describe anything that was actually observed.
 */
function erodeMask(mask, cols, rows, steps) {
  for (let step = 0; step < steps; step += 1) {
    const eroded = mask.slice();
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const i = y * cols + x;
        if (!mask[i]) continue;
        for (let d = 0; d < 4; d += 1) {
          const nx = x + [1, -1, 0, 0][d];
          const ny = y + [0, 0, 1, -1][d];
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || !mask[ny * cols + nx]) {
            eroded[i] = 0;
            break;
          }
        }
      }
    }
    mask.set(eroded);
  }
  return mask;
}

/**
 * Drops speckle islands while keeping every patch of real size. A single-pass
 * flyover often reconstructs a scene as several disjoint masses -- a ridge seen
 * edge-on has a very thin footprint from above and does not touch the massif
 * beside it -- so keeping only the biggest patch would discard half the model.
 */
function keepSignificantComponents(mask, cols, rows, minFraction = 0.04) {
  const label = new Int32Array(cols * rows).fill(-1);
  const queue = new Int32Array(cols * rows);
  const sizes = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || label[start] >= 0) continue;
    const current = sizes.length;
    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail += 1;
    label[start] = current;
    let size = 0;
    while (head < tail) {
      const cell = queue[head];
      head += 1;
      size += 1;
      const x = cell % cols;
      const y = (cell - x) / cols;
      for (let d = 0; d < 4; d += 1) {
        const nx = x + [1, -1, 0, 0][d];
        const ny = y + [0, 0, 1, -1][d];
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const ni = ny * cols + nx;
        if (!mask[ni] || label[ni] >= 0) continue;
        label[ni] = current;
        queue[tail] = ni;
        tail += 1;
      }
    }
    sizes.push(size);
  }
  if (!sizes.length) return mask;
  const threshold = Math.max(24, Math.max(...sizes) * minFraction);
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i] && sizes[label[i]] < threshold) mask[i] = 0;
  }
  return mask;
}

/**
 * Depth accuracy collapses far from the flight line, so cells are kept only out
 * to the radius that still contains the bulk of the observations. Without this
 * the far field contributes noise that reads as coral rather than landscape.
 */
function rangeMask(sampleCount, cols, rows, box, cameraXZ, keepFraction = 0.9) {
  if (!cameraXZ?.length) return null;
  const spanX = Math.max(1e-6, box.max[0] - box.min[0]);
  const spanZ = Math.max(1e-6, box.max[2] - box.min[2]);
  const distance = new Float32Array(cols * rows);
  let maxDistance = 0;
  for (let y = 0; y < rows; y += 1) {
    const wz = box.min[2] + (y / Math.max(1, rows - 1)) * spanZ;
    for (let x = 0; x < cols; x += 1) {
      const wx = box.min[0] + (x / Math.max(1, cols - 1)) * spanX;
      let best = Infinity;
      for (const camera of cameraXZ) {
        const dx = wx - camera[0];
        const dz = wz - camera[1];
        const d = dx * dx + dz * dz;
        if (d < best) best = d;
      }
      const value = Math.sqrt(best);
      distance[y * cols + x] = value;
      if (value > maxDistance) maxDistance = value;
    }
  }

  const BINS = 256;
  const histogram = new Float64Array(BINS);
  let totalSamples = 0;
  for (let i = 0; i < distance.length; i += 1) {
    if (!sampleCount[i]) continue;
    const bin = Math.min(BINS - 1, Math.floor((distance[i] / Math.max(1e-6, maxDistance)) * (BINS - 1)));
    histogram[bin] += sampleCount[i];
    totalSamples += sampleCount[i];
  }
  if (totalSamples <= 0) return null;
  let running = 0;
  let cutoffBin = BINS - 1;
  for (let b = 0; b < BINS; b += 1) {
    running += histogram[b];
    if (running >= totalSamples * keepFraction) {
      cutoffBin = b;
      break;
    }
  }
  const cutoff = ((cutoffBin + 1) / BINS) * maxDistance;
  const mask = new Uint8Array(cols * rows);
  for (let i = 0; i < mask.length; i += 1) mask[i] = distance[i] <= cutoff ? 1 : 0;
  return { mask, cutoff };
}

/**
 * The surface covers measured cells, any gap fully enclosed by measured cells,
 * and a thin margin around the outside. Interpolation is therefore only ever
 * asked to bridge a hole it is surrounded by; open space is left open, which
 * avoids the drapes that appear when a fill is allowed to reach into the void.
 */
function observedMask(sampleCount, cols, rows, margin) {
  const cells = cols * rows;
  const outside = new Uint8Array(cells);
  const queue = new Int32Array(cells);
  let head = 0;
  let tail = 0;
  const push = (i) => {
    if (outside[i] || sampleCount[i] > 0) return;
    outside[i] = 1;
    queue[tail] = i;
    tail += 1;
  };
  for (let x = 0; x < cols; x += 1) {
    push(x);
    push((rows - 1) * cols + x);
  }
  for (let y = 0; y < rows; y += 1) {
    push(y * cols);
    push(y * cols + cols - 1);
  }
  while (head < tail) {
    const cell = queue[head];
    head += 1;
    const x = cell % cols;
    const y = (cell - x) / cols;
    for (let d = 0; d < 4; d += 1) {
      const nx = x + [1, -1, 0, 0][d];
      const ny = y + [0, 0, 1, -1][d];
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      push(ny * cols + nx);
    }
  }

  const mask = new Uint8Array(cells);
  for (let i = 0; i < cells; i += 1) mask[i] = sampleCount[i] > 0 || !outside[i] ? 1 : 0;

  for (let step = 0; step < margin; step += 1) {
    const grown = mask.slice();
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const i = y * cols + x;
        if (mask[i]) continue;
        for (let d = 0; d < 4; d += 1) {
          const nx = x + [1, -1, 0, 0][d];
          const ny = y + [0, 0, 1, -1][d];
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          if (mask[ny * cols + nx]) {
            grown[i] = 1;
            break;
          }
        }
      }
    }
    mask.set(grown);
  }
  return mask;
}

function smoothHeights(height, mask, cols, rows, confidence, passes) {
  for (let pass = 0; pass < passes; pass += 1) {
    const next = height.slice();
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        const i = y * cols + x;
        if (!mask[i] || Number.isNaN(height[i])) continue;
        let sum = 0;
        let weight = 0;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
            const ni = ny * cols + nx;
            if (Number.isNaN(height[ni])) continue;
            const w = dx === 0 && dy === 0 ? 4 : (dx === 0 || dy === 0 ? 2 : 1);
            sum += height[ni] * w;
            weight += w;
          }
        }
        if (weight > 0) {
          // Confident cells keep their measured detail; cells whose samples
          // disagreed are mostly noise and relax toward their neighbours.
          const trust = Math.min(0.88, confidence[i]);
          next[i] = height[i] * trust + (sum / weight) * (1 - trust);
        }
      }
    }
    height.set(next);
  }
}

/** Pushes the median luminance toward mid-grey so hillshaded relief stays readable. */
function normalizeTone(rgb, mask) {
  const lums = [];
  for (let i = 0; i < mask.length; i += 1) {
    if (!mask[i]) continue;
    lums.push(0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2]);
  }
  if (lums.length < 32) return;
  lums.sort((a, b) => a - b);
  const median = percentile(lums, 0.5);
  if (median < 1) return;
  const gain = Math.max(0.6, Math.min(3.4, 138 / median));
  for (let i = 0; i < mask.length; i += 1) {
    rgb[i * 3] = Math.min(255, rgb[i * 3] * gain);
    rgb[i * 3 + 1] = Math.min(255, rgb[i * 3 + 1] * gain);
    rgb[i * 3 + 2] = Math.min(255, rgb[i * 3 + 2] * gain);
  }
}

function hillshade(positions, indices, baseColors) {
  const normals = computeNormals(positions, indices);
  const out = new Uint8Array(positions.length);
  const sun = [0.38, 0.82, 0.43];
  const length = Math.hypot(...sun);
  const sx = sun[0] / length;
  const sy = sun[1] / length;
  const sz = sun[2] / length;
  for (let i = 0; i < positions.length / 3; i += 1) {
    const lambert = normals[i * 3] * sx + normals[i * 3 + 1] * sy + normals[i * 3 + 2] * sz;
    const shade = 0.52 + 0.48 * Math.max(0, lambert);
    out[i * 3] = Math.min(255, Math.round(baseColors[i * 3] * shade));
    out[i * 3 + 1] = Math.min(255, Math.round(baseColors[i * 3 + 1] * shade));
    out[i * 3 + 2] = Math.min(255, Math.round(baseColors[i * 3 + 2] * shade));
  }
  return out;
}

export function buildTerrain(positions, colors, {
  resolution = 0,
  fillRadius = 0,
  smoothing = 2,
  cameraXZ = null,
} = {}) {
  const clipped = clipToCameraRange(positions, colors, cameraXZ);
  positions = clipped.positions;
  colors = clipped.colors;
  const box = boundsOf(positions);
  const spanX = Math.max(1e-6, box.max[0] - box.min[0]);
  const spanZ = Math.max(1e-6, box.max[2] - box.min[2]);
  const pointCount = positions.length / 3;
  // Size the grid so a typical cell lands on roughly nine depth samples: fine
  // enough to hold ridge detail, coarse enough that cells are not decided by
  // one or two noisy points.
  const longAxis = resolution
    || Math.max(220, Math.min(720, Math.round(Math.sqrt(pointCount / 9))));
  const cols = spanX >= spanZ ? longAxis : Math.max(64, Math.round(longAxis * (spanX / spanZ)));
  const rows = spanX >= spanZ ? Math.max(64, Math.round(longAxis * (spanZ / spanX))) : longAxis;

  const cellSize = Math.max(spanX / Math.max(1, cols - 1), spanZ / Math.max(1, rows - 1));
  const { height, rgb, sampleCount, confidence } = rasterizeSurface(
    positions, colors, box, cols, rows, cellSize,
  );

  const range = rangeMask(sampleCount, cols, rows, box, cameraXZ);
  if (range) {
    for (let i = 0; i < sampleCount.length; i += 1) {
      if (!range.mask[i]) {
        sampleCount[i] = 0;
        height[i] = EMPTY;
      }
    }
  }

  // Gate against the cells the flight could actually see, not the whole grid,
  // so a tightly-framed pass is not forced down to a useless threshold.
  const inRange = range
    ? range.mask.reduce((sum, value) => sum + value, 0)
    : cols * rows;
  const minSamples = gateBySupport(height, sampleCount, confidence, cols, rows, inRange * 0.22);
  const relief = Math.max(1e-6, box.max[1] - box.min[1]);
  const removed = despike(height, sampleCount, cols, rows, relief * 0.01, 4);

  const radius = fillRadius || Math.max(3, Math.round(Math.min(cols, rows) * 0.02));
  let mask = keepSignificantComponents(observedMask(sampleCount, cols, rows, radius), cols, rows);
  if (range) {
    for (let i = 0; i < mask.length; i += 1) mask[i] = mask[i] && range.mask[i] ? 1 : 0;
  }
  mask = keepSignificantComponents(erodeMask(mask, cols, rows, 2), cols, rows);
  pyramidFill(height, rgb, cols, rows, radius);
  relaxFilled(height, sampleCount, mask, cols, rows, 60);

  // A ground step steeper than about 63 degrees across one cell is
  // reconstruction noise rather than landscape, so clamp it before smoothing.
  const clamped = limitSlope(height, cols, rows, cellSize * 2, 12);

  smoothHeights(height, mask, cols, rows, confidence, smoothing);
  normalizeTone(rgb, mask);
  console.log(`  grid ${cols}x${rows} minSamples=${minSamples} despiked=${removed} slopeClamped=${clamped}`);

  const vertexIndex = new Int32Array(cols * rows).fill(-1);
  const meshPositions = [];
  const baseColors = [];
  const uvs = [];
  let vertexCount = 0;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const i = y * cols + x;
      if (!mask[i] || Number.isNaN(height[i])) continue;
      vertexIndex[i] = vertexCount;
      vertexCount += 1;
      meshPositions.push(
        box.min[0] + (x / (cols - 1)) * spanX,
        height[i],
        box.min[2] + (y / (rows - 1)) * spanZ,
      );
      baseColors.push(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
      uvs.push(x / (cols - 1), 1 - y / (rows - 1));
    }
  }
  // Quads spanning an implausible vertical step are reconstruction boundaries,
  // not landscape. Leaving them out gives a clean silhouette instead of the
  // vertical curtains a fully-connected grid would drape over every drop-off.
  const cellSizeX = spanX / Math.max(1, cols - 1);
  const cellSizeZ = spanZ / Math.max(1, rows - 1);
  const maxFaceDrop = Math.max(cellSizeX, cellSizeZ) * 24;
  const indices = [];
  let skipped = 0;
  for (let y = 0; y < rows - 1; y += 1) {
    for (let x = 0; x < cols - 1; x += 1) {
      const ia = y * cols + x;
      const ib = y * cols + x + 1;
      const ic = (y + 1) * cols + x;
      const id = (y + 1) * cols + x + 1;
      const a = vertexIndex[ia];
      const b = vertexIndex[ib];
      const c = vertexIndex[ic];
      const d = vertexIndex[id];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      const hi = Math.max(height[ia], height[ib], height[ic], height[id]);
      const lo = Math.min(height[ia], height[ib], height[ic], height[id]);
      if (hi - lo > maxFaceDrop) {
        skipped += 1;
        continue;
      }
      indices.push(a, c, b, b, c, d);
    }
  }
  console.log(`  quads dropped for over-steep step: ${skipped}`);
  if (!indices.length) throw new Error('Terrain grid produced no faces; the cloud is too sparse.');

  const meshPos = new Float32Array(meshPositions);
  const flatColors = new Uint8Array(baseColors.map((value) => Math.max(0, Math.min(255, Math.round(value)))));
  const meshIndices = new Uint32Array(indices);

  const tex = Buffer.alloc(cols * rows * 3);
  for (let i = 0; i < cols * rows; i += 1) {
    const visible = mask[i] && !Number.isNaN(height[i]);
    tex[i * 3] = visible ? Math.max(0, Math.min(255, Math.round(rgb[i * 3]))) : 16;
    tex[i * 3 + 1] = visible ? Math.max(0, Math.min(255, Math.round(rgb[i * 3 + 1]))) : 24;
    tex[i * 3 + 2] = visible ? Math.max(0, Math.min(255, Math.round(rgb[i * 3 + 2]))) : 30;
  }

  return {
    positions: meshPos,
    colors: hillshade(meshPos, meshIndices, flatColors),
    albedo: flatColors,
    uvs: new Float32Array(uvs),
    indices: meshIndices,
    ortho: encodePng(tex, cols, rows),
    grid: { cols, rows, box, height, mask },
    coverage: mask.reduce((sum, value) => sum + value, 0) / (cols * rows),
  };
}

/** Samples the finished surface under a world position, used to measure flight altitude. */
export function sampleTerrainHeight(grid, x, z) {
  const { cols, rows, box, height, mask } = grid;
  const spanX = Math.max(1e-6, box.max[0] - box.min[0]);
  const spanZ = Math.max(1e-6, box.max[2] - box.min[2]);
  const cx = Math.round(((x - box.min[0]) / spanX) * (cols - 1));
  const cz = Math.round(((z - box.min[2]) / spanZ) * (rows - 1));
  if (cx < 0 || cz < 0 || cx >= cols || cz >= rows) return Number.NaN;
  const i = cz * cols + cx;
  if (!mask[i] || Number.isNaN(height[i])) return Number.NaN;
  return height[i];
}
