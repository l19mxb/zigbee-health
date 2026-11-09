import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { decodeFloorImage, importAlarmDashLayout, MAX_ALARM_DASH_LAYOUT_BYTES } from '../src/floor-plan-import.mjs';

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return chunk;
}

function syntheticPng(textBytes = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const chunks = [Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header)];
  if (textBytes) chunks.push(pngChunk('tEXt', Buffer.concat([Buffer.from('Comment\0'), Buffer.alloc(textBytes, 'x')])));
  chunks.push(pngChunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255, 255]))), pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

const asImage = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
const onePixel = asImage(syntheticPng());
const rectangle = () => [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
const drawing = () => ({
  version: 1, revision: 7,
  floors: [{ id: 'floor_a', name: 'Ground', width: 1, height: 1, image: onePixel, rooms: [{
    id: 'room_a', name: ' Room ', points: rectangle(), label: [0.05, 0.95], openings: [
      { id: 'door_a', name: ' Door ', type: 'door', wall: { edgeIndex: 1, position: 0.35 }, width: 44.5, flip: true },
      { id: 'window_a', name: 'Window', type: 'window', wall: { edgeIndex: 2, position: 1 } },
    ],
  }] }],
});

test('imports only the drawing and preserves room labels and legacy openings', () => {
  const source = drawing();
  source.navigation = [{ url: 'https://example.invalid/legacy' }];
  const floor = source.floors[0];
  floor.cameras = [{ url: 'https://example.invalid/camera' }];
  floor.markers = [{ device: 'legacy-device' }];
  Object.assign(floor.rooms[0], { sensors: [{ key: 'alarm:legacy' }], activitySensor: 'alarm:legacy', labelSize: 'large' });
  Object.assign(floor.rooms[0].openings[0], { sensorKeys: ['alarm:legacy'], motionSensorKeys: ['alarm:motion'] });
  source.floors.push({ id: 'floor_b', name: 'Upper', width: 1000, height: 750, rooms: [
    { id: 'room_b', name: 'Legacy room', points: rectangle(), label: [0.5, 0.5] },
  ] });
  assert.deepEqual(importAlarmDashLayout(`\uFEFF${JSON.stringify(source)}`), [{
    id: 'floor_a', name: 'Ground', width: 1, height: 1, image: onePixel, markers: [], rooms: [{
      id: 'room_a', name: 'Room', points: rectangle(), label: [0.05, 0.95], openings: [
        { id: 'door_a', name: 'Door', type: 'door', edgeIndex: 1, position: 0.35, size: 44.5, swing: true },
        { id: 'window_a', name: 'Window', type: 'window', edgeIndex: 2, position: 1, size: 32, swing: false },
      ],
    }],
  }, {
    id: 'floor_b', name: 'Upper', width: 1000, height: 750, image: null, markers: [], rooms: [
      { id: 'room_b', name: 'Legacy room', points: rectangle(), label: [0.5, 0.5], openings: [] },
    ],
  }]);
});

test('checks the layout version, real UTF-8 byte budget and floor count', () => {
  assert.throws(() => importAlarmDashLayout('{'), /not valid JSON/);
  assert.throws(() => importAlarmDashLayout(JSON.stringify({ ...drawing(), version: 2 })), /version 1/);
  assert.throws(() => importAlarmDashLayout(JSON.stringify({ ...drawing(), revision: -1 })), /version 1/);
  assert.throws(() => importAlarmDashLayout('é'.repeat(MAX_ALARM_DASH_LAYOUT_BYTES / 2 + 1)), /8 MiB/);
  assert.throws(() => importAlarmDashLayout(JSON.stringify({ ...drawing(), floors: Array(9).fill(null) })), /at most 8/);
});

test('rejects malformed geometry, duplicate IDs and detached or invalid openings', () => {
  const cases = [
    [layout => { layout.floors[0].rooms[0].points = [[0, 0], [1, 1], [0, 1], [1, 0]]; }, /intersecting edges/],
    [layout => { layout.floors[0].rooms[0].points[1] = [0.1, 0.1]; }, /duplicate corners/],
    [layout => { layout.floors[0].rooms[0].points[1] = [1.1, 0]; }, /inside the plan/],
    [layout => { layout.floors[0].rooms[0].label = [0.3, -1]; }, /label position/],
    [layout => { layout.floors[0].rooms[0].name = 'Two\nlines'; }, /single-line name/],
    [layout => { layout.floors[0].rooms.push(layout.floors[0].rooms[0]); }, /unique ID/],
    [layout => { layout.floors[0].rooms[0].openings[0].wall.edgeIndex = 4; }, /valid room edge/],
    [layout => { layout.floors[0].rooms[0].openings[0].wall.position = '0.35'; }, /valid room edge/],
    [layout => { layout.floors[0].rooms[0].openings[0].width = 101; }, /symbol size/],
    [layout => { layout.floors[0].rooms[0].openings[0].flip = 'true'; }, /swing/],
  ];
  for (const [alter, error] of cases) {
    const layout = drawing();
    alter(layout);
    assert.throws(() => importAlarmDashLayout(JSON.stringify(layout)), error);
  }
});

test('only imports bounded embedded PNGs with matching dimensions and complete image chunks', () => {
  const corrupted = syntheticPng();
  corrupted[41] ^= 1;
  const still = syntheticPng();
  const animated = Buffer.concat([still.subarray(0, 33), pngChunk('acTL', Buffer.from([0, 0, 0, 1, 0, 0, 0, 0])), still.subarray(33)]);
  for (const [image, width, expected] of [
    ['https://example.invalid/plan.png', 1, /embedded PNG/],
    ['data:image/svg+xml;base64,PHN2Zy8+', 1, /embedded PNG/],
    [asImage(Buffer.from('<svg/>')), 1, /invalid PNG/],
    [onePixel, 2, /dimensions/],
    [asImage(corrupted), 1, /invalid PNG chunk/],
    [asImage(animated), 1, /still PNG/],
    [asImage(syntheticPng().subarray(0, -12)), 1, /incomplete PNG/],
    [asImage(Buffer.alloc(2 * 1024 * 1024 + 1)), 1, /larger than 2 MiB/],
  ]) {
    const source = drawing();
    Object.assign(source.floors[0], { image, width });
    assert.throws(() => importAlarmDashLayout(JSON.stringify(source)), expected);
  }
  const image = asImage(syntheticPng(1_800_000));
  const source = { version: 1, revision: 0, floors: [1, 2, 3].map(i => ({ id: `f${i}`, name: `Floor ${i}`, width: 1, height: 1, image, rooms: [] })) };
  assert.throws(() => importAlarmDashLayout(JSON.stringify(source)), /together exceed 5 MiB/);
});

test('image decoding rejects unsafe MIME, fake raster contents and oversized files', async () => {
  const svg = new File(['<svg/>'], 'plan.svg', { type: 'image/svg+xml' });
  const disguisedSvg = new File(['<svg/>'], 'plan.png', { type: 'image/png' });
  const oversized = { type: 'image/webp', size: 20 * 1024 * 1024 + 1 };
  await assert.rejects(decodeFloorImage(svg), /PNG, JPG or WebP/);
  await assert.rejects(decodeFloorImage(disguisedSvg), /contents do not match/);
  await assert.rejects(decodeFloorImage(oversized), /20 MiB/);
  const excessive = syntheticPng();
  excessive.writeUInt32BE(100_000_001, 16);
  await assert.rejects(decodeFloorImage(new File([excessive], 'plan.png', { type: 'image/png' })), /dimensions are too large/);
});

test('browser decode fits the image and shrinks an oversized PNG output', async t => {
  const largeOutput = asImage(Buffer.alloc(2 * 1024 * 1024 + 1));
  const drawnSizes = [];
  let closed = 0;
  const bitmap = { width: 4000, height: 2000, close: () => { closed++; } };
  const canvas = {
    getContext(kind) {
      assert.equal(kind, '2d');
      return { drawImage(source, x, y, width, height) {
        assert.equal(source, bitmap);
        assert.deepEqual([x, y, width, height], [0, 0, canvas.width, canvas.height]);
        drawnSizes.push([width, height]);
      } };
    },
    toDataURL(kind) {
      assert.equal(kind, 'image/png');
      return drawnSizes.length === 1 ? largeOutput : onePixel;
    },
  };
  const file = new File([Buffer.from('ffd8ff', 'hex')], 'plan.jpg', { type: 'image/jpeg' });
  const originalBitmap = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  t.after(() => {
    if (originalBitmap) Object.defineProperty(globalThis, 'createImageBitmap', originalBitmap);
    else delete globalThis.createImageBitmap;
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  });
  globalThis.createImageBitmap = async input => { assert.equal(input, file); return bitmap; };
  globalThis.document = { createElement(tag) { assert.equal(tag, 'canvas'); return canvas; } };
  const result = await decodeFloorImage(file);
  assert.deepEqual(drawnSizes, [[2400, 1200], [2040, 1020]]);
  assert.deepEqual(result, { image: onePixel, width: 2040, height: 1020 });
  assert.equal(closed, 1);
});
