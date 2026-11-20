/**
 * Local change analysis and thumbnails, reusing three Apache-2.0 modules from
 * dsh-see-now 0.0.7 (see ./vendor/see-now/NOTICE):
 *   - cuts.js: 64×36 RGB grid + HSV weighted difference
 *   - scale.js: cover scaling
 *   - png.js: pure-JS PNG encoding
 *
 * No ffmpeg, model or desktop input is used here. Raw RGB comes from mss.
 */
import { gridRgb, rgbToHsv, scorePair, SCAN_W, SCAN_H } from './vendor/see-now/cuts.js';
import { coverInto } from './vendor/see-now/scale.js';
import { encodePng } from './vendor/see-now/png.js';

export const CHANGE_THRESHOLD = 8;
export const THUMB_WIDTH = 320;
export const THUMB_HEIGHT = 180;

function bboxFromHsv(previous, current, width, height, threshold, minRegionCells) {
  const changedCells = new Uint8Array(SCAN_W * SCAN_H);
  const weights = new Float32Array(SCAN_W * SCAN_H);
  let changed = 0;
  for (let gy = 0; gy < SCAN_H; gy += 1) {
    for (let gx = 0; gx < SCAN_W; gx += 1) {
      const idx = gy * SCAN_W + gx;
      const i = idx * 3;
      const dh = Math.abs(current[i] - previous[i]);
      const hueDiff = Math.min(dh, 255 - dh);
      const hueWeight = Math.min(current[i + 1], previous[i + 1]) / 255;
      const diff = hueDiff * hueWeight
        + Math.abs(current[i + 1] - previous[i + 1])
        + Math.abs(current[i + 2] - previous[i + 2]);
      if (diff >= threshold) {
        changedCells[idx] = 1;
        weights[idx] = diff;
        changed += 1;
      }
    }
  }

  const visited = new Uint8Array(SCAN_W * SCAN_H);
  const allRegions = [];
  const neighbors = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ];
  const cellBox = (minX, minY, maxX, maxY) => ({
    left: Math.floor((minX * width) / SCAN_W),
    top: Math.floor((minY * height) / SCAN_H),
    width: Math.max(1, Math.ceil(((maxX + 1) * width) / SCAN_W)
      - Math.floor((minX * width) / SCAN_W)),
    height: Math.max(1, Math.ceil(((maxY + 1) * height) / SCAN_H)
      - Math.floor((minY * height) / SCAN_H)),
  });

  for (let start = 0; start < changedCells.length; start += 1) {
    if (!changedCells[start] || visited[start]) continue;
    const queue = [start];
    visited[start] = 1;
    let cursor = 0;
    let count = 0;
    let weight = 0;
    let minX = SCAN_W;
    let minY = SCAN_H;
    let maxX = -1;
    let maxY = -1;
    while (cursor < queue.length) {
      const idx = queue[cursor];
      cursor += 1;
      const gx = idx % SCAN_W;
      const gy = Math.floor(idx / SCAN_W);
      count += 1;
      weight += weights[idx];
      minX = Math.min(minX, gx);
      minY = Math.min(minY, gy);
      maxX = Math.max(maxX, gx);
      maxY = Math.max(maxY, gy);
      for (const [dx, dy] of neighbors) {
        const nx = gx + dx;
        const ny = gy + dy;
        if (nx < 0 || ny < 0 || nx >= SCAN_W || ny >= SCAN_H) continue;
        const nidx = ny * SCAN_W + nx;
        if (!changedCells[nidx] || visited[nidx]) continue;
        visited[nidx] = 1;
        queue.push(nidx);
      }
    }
    allRegions.push({
      ...cellBox(minX, minY, maxX, maxY),
      cells: count,
      weight: Math.round(weight * 10) / 10,
    });
  }

  allRegions.sort((a, b) => b.cells - a.cells || b.weight - a.weight);
  const regions = allRegions.filter(region => region.cells >= minRegionCells);
  return {
    changed,
    ratio: Math.round((changed / (SCAN_W * SCAN_H)) * 10000) / 10000,
    bbox: regions[0] ?? null,
    regions: regions.slice(0, 5),
    filteredRegions: allRegions.length - regions.length,
  };
}

export class FrameChangeAnalyzer {
  constructor({ threshold = CHANGE_THRESHOLD, minRegionCells = 2 } = {}) {
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 255) {
      throw new Error('threshold must be 0..255');
    }
    if (!Number.isInteger(minRegionCells) || minRegionCells < 1 || minRegionCells > 32) {
      throw new Error('minRegionCells must be 1..32');
    }
    this.threshold = threshold;
    this.minRegionCells = minRegionCells;
    this.previous = null;
    this.width = 0;
    this.height = 0;
    this.rgb = new Float32Array(SCAN_W * SCAN_H * 3);
    this.hsv = new Float32Array(SCAN_W * SCAN_H * 3);
  }

  analyze(raw, width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height)
        || width < 1 || height < 1 || raw.length < width * height * 3) {
      throw new Error('raw frame is too small for its dimensions');
    }
    gridRgb(raw, width, height, this.rgb);
    rgbToHsv(this.rgb, this.hsv);
    const dimensionsChanged = this.previous !== null
      && (this.width !== width || this.height !== height);
    let score = 0;
    let ratio = 0;
    let bbox = null;
    let regions = [];
    let filteredRegions = 0;
    let firstFrame = false;
    if (dimensionsChanged) {
      score = 255;
      ratio = 1;
      bbox = { left: 0, top: 0, width, height };
      regions = [{ ...bbox, cells: SCAN_W * SCAN_H, weight: 255 }];
    } else if (this.previous === null) {
      firstFrame = true;
    } else {
      score = scorePair(this.previous, this.hsv);
      const result = bboxFromHsv(this.previous, this.hsv, width, height,
        this.threshold, this.minRegionCells);
      ratio = result.ratio;
      bbox = result.bbox;
      regions = result.regions;
      filteredRegions = result.filteredRegions;
    }
    this.previous = new Float32Array(this.hsv);
    this.width = width;
    this.height = height;
    return {
      changed_score: Math.max(0, Math.min(255, Math.round(score))),
      changed_ratio: ratio,
      change_bbox: bbox,
      change_regions: regions,
      filtered_regions: filteredRegions,
      first_frame: firstFrame,
      dimensions_changed: dimensionsChanged,
      scan_width: SCAN_W,
      scan_height: SCAN_H,
    };
  }
}

export function makeThumbnail(raw, width, height, bbox = null,
  { thumbWidth = THUMB_WIDTH, thumbHeight = THUMB_HEIGHT, level = 1 } = {}) {
  let left = 0;
  let top = 0;
  let sourceWidth = width;
  let sourceHeight = height;
  if (bbox && bbox.width > 0 && bbox.height > 0) {
    left = Math.max(0, Math.min(width - 1, Math.trunc(bbox.left)));
    top = Math.max(0, Math.min(height - 1, Math.trunc(bbox.top)));
    sourceWidth = Math.max(1, Math.min(width - left, Math.trunc(bbox.width)));
    sourceHeight = Math.max(1, Math.min(height - top, Math.trunc(bbox.height)));
  }
  const crop = Buffer.allocUnsafe(sourceWidth * sourceHeight * 3);
  const rowBytes = sourceWidth * 3;
  for (let y = 0; y < sourceHeight; y += 1) {
    const from = ((top + y) * width + left) * 3;
    raw.copy
      ? raw.copy(crop, y * rowBytes, from, from + rowBytes)
      : crop.set(raw.subarray(from, from + rowBytes), y * rowBytes);
  }
  const scaled = Buffer.allocUnsafe(thumbWidth * thumbHeight * 3);
  coverInto(crop, sourceWidth, sourceHeight, scaled, thumbWidth, thumbHeight);
  const png = encodePng(scaled, thumbWidth, thumbHeight, { level });
  return {
    png,
    width: thumbWidth,
    height: thumbHeight,
    source_bbox: { left, top, width: sourceWidth, height: sourceHeight },
  };
}
