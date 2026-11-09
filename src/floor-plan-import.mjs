export const MAX_ALARM_DASH_LAYOUT_BYTES = 8 * 1024 * 1024;

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_LAYOUT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_EDGE = 2400;
const MAX_SOURCE_PIXELS = 100_000_000;
const PNG_PREFIX = 'data:image/png;base64,';
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let crc = byte;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc;
});
const UPLOAD_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

function boundedArray(value, max, context) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${context} must contain at most ${max} items.`);
  return value;
}

function drawingIdentity(item, seen, context) {
  const { id, name } = item ?? {};
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || seen.has(id)) {
    throw new Error(`${context} needs a valid, unique ID.`);
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\u0000-\u001f\u007f]/u.test(name.trim())) {
    throw new Error(`${context} needs a single-line name of up to 80 characters.`);
  }
  seen.add(id);
  return { id, name: name.trim() };
}

function normalized(value) {
  return typeof value === 'number' && value >= 0 && value <= 1;
}

function point(value) {
  return Array.isArray(value) && value.length === 2 && value.every(normalized);
}

function orientation([ax, ay], [bx, by], [cx, cy]) {
  const determinant = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return Math.abs(determinant) < 1e-10 ? 0 : Math.sign(determinant);
}

function between(point, a, b) {
  return point.every((value, axis) => value >= Math.min(a[axis], b[axis]) - 1e-10 && value <= Math.max(a[axis], b[axis]) + 1e-10);
}

function edgesTouch(a, b, c, d) {
  const abc = orientation(a, b, c), abd = orientation(a, b, d);
  const cda = orientation(c, d, a), cdb = orientation(c, d, b);
  return (abc * abd < 0 && cda * cdb < 0)
    || (abc === 0 && between(c, a, b)) || (abd === 0 && between(d, a, b))
    || (cda === 0 && between(a, c, d)) || (cdb === 0 && between(b, c, d));
}

function roomPoints(points, context) {
  if (!Array.isArray(points) || points.length < 3 || points.length > 64 || !points.every(point)) {
    throw new Error(`${context} needs 3 to 64 corners inside the plan.`);
  }
  if (new Set(points.map(pair => pair.join(','))).size !== points.length) throw new Error(`${context} has duplicate corners.`);
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    twiceArea += a[0] * b[1] - a[1] * b[0];
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      if (edgesTouch(a, b, points[j], points[(j + 1) % points.length])) throw new Error(`${context} has intersecting edges.`);
    }
  }
  if (Math.abs(twiceArea) < 0.00002) throw new Error(`${context} has too little area.`);
  return points.map(pair => [...pair]);
}

function base64ByteLength(encoded) {
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return encoded.length / 4 * 3 - padding;
}

function matchesPngSignature(bytes) {
  return PNG_SIGNATURE.every((byte, i) => byte === bytes[i]);
}

function pngChecksum(bytes, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = PNG_CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectImportedPng(image, width, height, context) {
  if (typeof image !== 'string' || !image.startsWith(PNG_PREFIX)) throw new Error(`${context} needs an embedded PNG background.`);
  const encoded = image.slice(PNG_PREFIX.length);
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error(`${context} has invalid PNG data.`);
  const size = base64ByteLength(encoded);
  if (size > MAX_IMAGE_BYTES) throw new Error(`${context} has a background larger than 2 MiB. Resize it before importing.`);
  const binary = atob(encoded);
  if (btoa(binary) !== encoded) throw new Error(`${context} has invalid PNG data.`);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const hasHeader = bytes.length >= 33 && matchesPngSignature(bytes)
    && view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452;
  if (!hasHeader || view.getUint32(16) !== width || view.getUint32(20) !== height) {
    throw new Error(`${context} has invalid PNG dimensions or data.`);
  }
  let hasImageData = false;
  let chunks = 0;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset);
    const end = offset + 8 + length;
    if (end + 4 > bytes.length) break;
    const tag = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (['acTL', 'fcTL', 'fdAT'].includes(tag)) throw new Error(`${context} needs a still PNG background.`);
    if (++chunks > 2048 || !/^[A-Za-z]{4}$/.test(tag) || (tag === 'IHDR' && offset !== 8)
      || pngChecksum(bytes, offset + 4, end) !== view.getUint32(end)) {
      throw new Error(`${context} has an invalid PNG chunk.`);
    }
    if (tag === 'IDAT' && length > 0) hasImageData = true;
    if (tag === 'IEND') {
      if (length === 0 && end + 4 === bytes.length && hasImageData) return size;
      break;
    }
    offset = end + 4;
  }
  throw new Error(`${context} has incomplete PNG data.`);
}

/** Read the version 1 Alarm Dash layout format. Build a new drawing without its live mappings. */
export function importAlarmDashLayout(text) {
  const encoder = new TextEncoder();
  if (typeof text !== 'string' || text.length > MAX_ALARM_DASH_LAYOUT_BYTES || encoder.encode(text).length > MAX_ALARM_DASH_LAYOUT_BYTES) {
    throw new Error('Choose an Alarm Dash layout JSON file of up to 8 MiB.');
  }
  let document;
  try { document = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error('The layout file is not valid JSON.'); }
  if (document?.version !== 1 || !Number.isSafeInteger(document.revision) || document.revision < 0) {
    throw new Error('Choose a version 1 Alarm Dash layout file.');
  }
  const floorIds = new Set(), roomIds = new Set(), openingIds = new Set();
  let imageBytes = 0;
  const floors = boundedArray(document.floors, 8, 'The layout').map((floor, floorIndex) => {
    const context = `Floor ${floorIndex + 1}`;
    const identity = drawingIdentity(floor, floorIds, context);
    const { width, height, image = null } = floor;
    if (![width, height].every(value => Number.isInteger(value) && value >= 1 && value <= MAX_IMAGE_EDGE)) {
      throw new Error(`${context} needs dimensions between 1 and 2400 pixels.`);
    }
    if (image !== null) {
      imageBytes += inspectImportedPng(image, width, height, context);
      if (imageBytes > MAX_LAYOUT_IMAGE_BYTES) throw new Error('The backgrounds together exceed 5 MiB. Resize them before importing.');
    }
    const rooms = boundedArray(floor.rooms, 100, `${context} rooms`).map((room, roomIndex) => {
      const roomContext = `${context}, room ${roomIndex + 1}`;
      const roomIdentity = drawingIdentity(room, roomIds, roomContext);
      const points = roomPoints(room.points, roomContext);
      if (!point(room.label)) throw new Error(`${roomContext} needs a label position inside the plan.`);
      const openingRows = room.openings === undefined ? [] : room.openings;
      const openings = boundedArray(openingRows, 40, `${roomContext} openings`).map((opening, openingIndex) => {
        const openingContext = `${roomContext}, opening ${openingIndex + 1}`;
        const openingIdentity = drawingIdentity(opening, openingIds, openingContext);
        const { type, flip: swing = false, wall } = opening;
        const size = opening.width ?? 32;
        const { edgeIndex, position } = wall ?? {};
        if ((type !== 'door' && type !== 'window') || !Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= points.length || !normalized(position)) {
          throw new Error(`${openingContext} needs a door or window on a valid room edge.`);
        }
        if (!Number.isFinite(size) || size < 16 || size > 100 || typeof swing !== 'boolean') {
          throw new Error(`${openingContext} has an invalid symbol size or swing.`);
        }
        return { ...openingIdentity, type, edgeIndex, position, size, swing };
      });
      return { ...roomIdentity, points, label: [...room.label], openings };
    });
    return { ...identity, width, height, image, rooms, markers: [] };
  });
  if (encoder.encode(JSON.stringify({ version: 1, revision: Number.MAX_SAFE_INTEGER, floors })).length > MAX_ALARM_DASH_LAYOUT_BYTES) {
    throw new Error('The imported drawing exceeds the 8 MiB layout limit.');
  }
  return floors;
}

function matchesUploadType(bytes, type) {
  if (type === 'image/png') return matchesPngSignature(bytes);
  if (type === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
}

function checkSourceDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_SOURCE_PIXELS) {
    throw new Error('The image dimensions are too large or invalid.');
  }
}

/** Convert a selected raster file to a bounded PNG without reading any URL. */
export async function decodeFloorImage(file) {
  if (!file || !UPLOAD_TYPES.has(file.type)) throw new Error('Choose a PNG, JPG or WebP image.');
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_UPLOAD_BYTES) throw new Error('Choose an image file of up to 20 MiB.');
  const header = new Uint8Array(await file.slice(0, 24).arrayBuffer());
  if (!matchesUploadType(header, file.type)) throw new Error('The file contents do not match the selected image type.');
  if (file.type === 'image/png' && header.length >= 24) {
    const view = new DataView(header.buffer);
    checkSourceDimensions(view.getUint32(16), view.getUint32(20));
  }

  let bitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error('The image could not be opened.'); }
  try {
    checkSourceDimensions(bitmap.width, bitmap.height);
    let scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser could not prepare the image.');
    for (let attempt = 0; attempt < 6; attempt++) {
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.width = width;
      canvas.height = height;
      context.drawImage(bitmap, 0, 0, width, height);
      const image = canvas.toDataURL('image/png');
      if (!image.startsWith(PNG_PREFIX)) throw new Error('The browser could not encode the background as PNG.');
      const size = base64ByteLength(image.slice(PNG_PREFIX.length));
      if (size <= MAX_IMAGE_BYTES) return { image, width, height };
      scale *= Math.min(0.85, 0.9 * Math.sqrt(MAX_IMAGE_BYTES / size));
    }
    throw new Error('The PNG background is still larger than 2 MiB. Choose a smaller image.');
  } finally {
    bitmap.close();
  }
}
