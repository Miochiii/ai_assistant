import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHANGE_THRESHOLD,
  FrameChangeAnalyzer,
  THUMB_HEIGHT,
  THUMB_WIDTH,
  makeThumbnail,
} from '../plugins/dsh-assistant-host/frame-analysis.js';

function solid(width, height, color) {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i += 3) {
    raw[i] = color[0];
    raw[i + 1] = color[1];
    raw[i + 2] = color[2];
  }
  return raw;
}

test('first frame is zero and later identical frames are zero', () => {
  const analyzer = new FrameChangeAnalyzer();
  const frame = solid(64, 48, [20, 40, 60]);
  const first = analyzer.analyze(frame, 64, 48);
  assert.equal(first.changed_score, 0);
  assert.equal(first.changed_ratio, 0);
  assert.equal(first.change_bbox, null);
  assert.equal(first.first_frame, true);
  const same = analyzer.analyze(frame, 64, 48);
  assert.equal(same.changed_score, 0);
  assert.equal(same.change_bbox, null);
  assert.equal(same.first_frame, false);
});

test('changing the right half produces a score and a right-side bbox', () => {
  const analyzer = new FrameChangeAnalyzer({ threshold: CHANGE_THRESHOLD });
  const width = 64;
  const height = 48;
  const base = solid(width, height, [20, 40, 60]);
  analyzer.analyze(base, width, height);
  const changed = Buffer.from(base);
  for (let y = 0; y < height; y += 1) {
    for (let x = width / 2; x < width; x += 1) {
      const i = (y * width + x) * 3;
      changed[i] = 240;
      changed[i + 1] = 220;
      changed[i + 2] = 40;
    }
  }
  const result = analyzer.analyze(changed, width, height);
  assert.ok(result.changed_score > 0);
  assert.ok(result.changed_ratio > 0.2);
  assert.ok(result.change_bbox.left >= width / 2 - 2);
  assert.equal(result.first_frame, false);
});

test('clusters separated changes and picks the largest region', () => {
  const analyzer = new FrameChangeAnalyzer();
  const width = 64;
  const height = 48;
  const base = solid(width, height, [10, 10, 10]);
  analyzer.analyze(base, width, height);
  const changed = Buffer.from(base);
  const paint = (x0, y0, x1, y1, color) => {
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * width + x) * 3;
        changed[i] = color[0];
        changed[i + 1] = color[1];
        changed[i + 2] = color[2];
      }
    }
  };
  paint(2, 2, 8, 8, [255, 0, 0]);
  paint(40, 24, 60, 44, [0, 255, 0]);
  const result = analyzer.analyze(changed, width, height);
  assert.equal(result.change_regions.length, 2);
  assert.equal(result.change_regions[0].cells > result.change_regions[1].cells, true);
  assert.ok(result.change_bbox.left >= 40);
  assert.ok(result.change_bbox.top >= 24);
  assert.ok(result.change_bbox.width < width);
});

test('filters isolated single-cell changes below minRegionCells', () => {
  const analyzer = new FrameChangeAnalyzer({ minRegionCells: 2 });
  const width = 64;
  const height = 48;
  const base = solid(width, height, [10, 10, 10]);
  analyzer.analyze(base, width, height);
  const changed = Buffer.from(base);
  const i = 0;
  changed[i] = 255;
  changed[i + 1] = 255;
  changed[i + 2] = 255;
  const result = analyzer.analyze(changed, width, height);
  assert.equal(result.change_bbox, null);
  assert.deepEqual(result.change_regions, []);
  assert.ok(result.filtered_regions >= 1);
  assert.ok(result.changed_ratio > 0);
});

test('thumbnail uses See Now cover scaling and pure-JS PNG', () => {
  const raw = solid(200, 100, [200, 30, 30]);
  const thumb = makeThumbnail(raw, 200, 100, { left: 50, top: 20, width: 100, height: 60 });
  assert.equal(thumb.width, THUMB_WIDTH);
  assert.equal(thumb.height, THUMB_HEIGHT);
  assert.equal(thumb.png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(thumb.png.readUInt32BE(16), THUMB_WIDTH);
  assert.equal(thumb.png.readUInt32BE(20), THUMB_HEIGHT);
  assert.deepEqual(thumb.source_bbox, { left: 50, top: 20, width: 100, height: 60 });
});

test('dimension changes reset the comparison explicitly', () => {
  const analyzer = new FrameChangeAnalyzer();
  analyzer.analyze(solid(10, 10, [1, 2, 3]), 10, 10);
  const result = analyzer.analyze(solid(12, 10, [1, 2, 3]), 12, 10);
  assert.equal(result.changed_score, 255);
  assert.equal(result.changed_ratio, 1);
  assert.equal(result.dimensions_changed, true);
  assert.deepEqual(result.change_bbox, { left: 0, top: 0, width: 12, height: 10 });
});
