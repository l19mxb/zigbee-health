import {crc32} from 'node:zlib';
import {hasPermission} from './accounts.mjs';

export const floorPlanBodyLimit = 8 * 1024 ** 2;
const imageLimit = 2 * 1024 ** 2;
const totalImageLimit = 5 * 1024 ** 2;
const imagePrefix = 'data:image/png;base64,';
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const layoutKey = 'floorPlanLayout';
const imageKey = id => 'floorPlanImage:' + id;

export class FloorPlanError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function requireValue(valid, message, statusCode) {
  if (!valid) throw new FloorPlanError(message, statusCode);
}

export function floorPlanPermissions(user) {
  const health = hasPermission(user, 'viewHealth');
  const security = hasPermission(user, 'viewSecurity');
  return {health, security, edit: (health && hasPermission(user, 'manageDevices')) || (security && hasPermission(user, 'manageSecurity'))};
}

function fields(value, allowed, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key)), `Invalid ${label} fields`);
}

function list(value, max, label) {
  requireValue(Array.isArray(value) && value.length <= max, `Invalid ${label} list`);
  return value;
}

function identifier(value, label) {
  requireValue(typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value), `Invalid ${label} ID`);
  return value;
}

function name(value, label) {
  requireValue(typeof value === 'string' && value.length <= 100 && value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value), `Invalid ${label} name`);
  return value.trim();
}

function number(value, min, max, label) {
  requireValue(Number.isFinite(value) && value >= min && value <= max, `Invalid ${label}`);
  return value;
}

function integer(value, min, max, label) {
  requireValue(Number.isInteger(value), `Invalid ${label}`);
  return number(value, min, max, label);
}

function point(value) {
  requireValue(Array.isArray(value) && value.length === 2, 'Use normalized coordinate pairs');
  return value.map(coordinate => number(coordinate, 0, 1, 'coordinate'));
}

function unique(set, value, label) {
  requireValue(!set.has(value), `Duplicate ${label}`);
  set.add(value);
}

function imageSize(value, width, height) {
  if (value === null) return 0;
  requireValue(typeof value === 'string' && value.startsWith(imagePrefix)
    && value.length <= imagePrefix.length + 4 * Math.ceil(imageLimit / 3), 'Use a PNG image up to 2 MiB');
  const encoded = value.slice(imagePrefix.length);
  const png = Buffer.from(encoded, 'base64');
  requireValue(png.length >= 45 && png.length <= imageLimit && png.toString('base64') === encoded
    && png.subarray(0, 8).equals(pngSignature), 'Invalid PNG image');
  requireValue(png.readUInt32BE(8) === 13 && png.toString('ascii', 12, 16) === 'IHDR', 'Invalid PNG header');
  requireValue(png.readUInt32BE(16) === width && png.readUInt32BE(20) === height,
    'PNG dimensions must match the floor dimensions');
  const depths = {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]};
  requireValue(depths[png[25]]?.includes(png[24]) && png[26] === 0 && png[27] === 0 && png[28] <= 1,
    'Invalid PNG image format');
  let hasData = false;
  let chunks = 0;
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const end = offset + 8 + length;
    requireValue(++chunks <= 2048 && end + 4 <= png.length, 'Invalid PNG chunk');
    const type = png.toString('latin1', offset + 4, offset + 8);
    requireValue(/^[A-Za-z]{4}$/.test(type) && !['acTL', 'fcTL', 'fdAT'].includes(type)
      && (type !== 'IHDR' || offset === 8)
      && crc32(png.subarray(offset + 4, end)) === png.readUInt32BE(end), 'Invalid or animated PNG image');
    if (type === 'IDAT' && length) hasData = true;
    if (type === 'IEND') {
      requireValue(length === 0 && hasData && end + 4 === png.length, 'Invalid PNG ending');
      return png.length;
    }
    offset = end + 4;
  }
  throw new FloorPlanError('Incomplete PNG image');
}

function normalizeRoom(input, roomIds, openingIds) {
  fields(input, ['id', 'name', 'points', 'label', 'openings'], 'room');
  const id = identifier(input.id, 'room');
  unique(roomIds, id, 'room ID');
  const points = list(input.points, 64, 'room points').map(point);
  requireValue(points.length >= 3, 'A room needs at least three points');
  const signedArea = points.reduce((sum, [x, y], index) => {
    const [nextX, nextY] = points[(index + 1) % points.length];
    requireValue(x !== nextX || y !== nextY, 'Room edges need two distinct points');
    return sum + x * nextY - y * nextX;
  }, 0);
  requireValue(Math.abs(signedArea) > 1e-10, 'Room outline needs an area');
  const openings = list(input.openings ?? [], 40, 'openings').map(opening => {
    fields(opening, ['id', 'name', 'type', 'edgeIndex', 'position', 'size', 'swing'], 'opening');
    const openingId = identifier(opening.id, 'opening');
    unique(openingIds, openingId, 'opening ID');
    requireValue(['door', 'window'].includes(opening.type) && typeof opening.swing === 'boolean', 'Invalid opening type or swing');
    return {id: openingId, name: name(opening.name, 'opening'), type: opening.type,
      edgeIndex: integer(opening.edgeIndex, 0, points.length - 1, 'opening edge'),
      position: number(opening.position, 0, 1, 'opening position'),
      size: number(opening.size, 16, 100, 'opening size'), swing: opening.swing};
  });
  return {id, name: name(input.name, 'room'), points, label: input.label == null ? null : point(input.label), openings};
}

const canPlaceDevice = device => !device.retiredAt && !device.disabled;

function normalizeLayout(input, visibleDevices, previousIds) {
  const floorIds = new Set();
  const marked = new Set();
  let imageBytes = 0;
  const floors = list(input.floors, 8, 'floors').map(floor => {
    fields(floor, ['id', 'name', 'width', 'height', 'image', 'rooms', 'markers'], 'floor');
    const id = identifier(floor.id, 'floor');
    unique(floorIds, id, 'floor ID');
    const width = integer(floor.width, 1, 2400, 'floor width');
    const height = integer(floor.height, 1, 2400, 'floor height');
    const image = floor.image ?? null;
    imageBytes += imageSize(image, width, height);
    requireValue(imageBytes <= totalImageLimit, 'Floor plan backgrounds exceed 5 MiB');
    const openingIds = new Set();
    const roomIds = new Set();
    const rooms = list(floor.rooms ?? [], 100, 'rooms').map(room => normalizeRoom(room, roomIds, openingIds));
    const attached = new Set();
    const markers = list(floor.markers ?? [], 1024, 'markers').map(marker => {
      fields(marker, ['deviceId', 'position', 'openingId'], 'marker');
      const device = visibleDevices.get(marker.deviceId);
      requireValue(device, 'Choose a device you can view', 403);
      requireValue(canPlaceDevice(device) || previousIds.has(marker.deviceId), 'Retired or excluded devices cannot be placed', 403);
      unique(marked, marker.deviceId, 'device placement');
      const normalized = {deviceId: marker.deviceId, position: point(marker.position)};
      if (marker.openingId != null) {
        const openingId = identifier(marker.openingId, 'marker opening');
        requireValue(openingIds.has(openingId), 'Choose an opening on the same floor');
        unique(attached, openingId, 'opening placement');
        normalized.openingId = openingId;
      }
      return normalized;
    });
    return {id, name: name(floor.name, 'floor'), width, height, image, rooms, markers};
  });
  return {version: 1, revision: input.revision + 1, floors};
}

function openingPositions(floor) {
  return new Map(floor.rooms.flatMap(({points, openings}) => openings.map(({id, edgeIndex, position}) => (
    [id, JSON.stringify([points[edgeIndex], points[(edgeIndex + 1) % points.length], position])]))));
}

function preserveHiddenMarkers(previous, next, visibleDevices, currentIds) {
  for (const oldFloor of previous.floors) {
    const hidden = oldFloor.markers.filter(marker => currentIds.has(marker.deviceId) && !visibleDevices.has(marker.deviceId));
    if (!hidden.length) continue;
    const floor = next.floors.find(item => item.id === oldFloor.id);
    requireValue(floor, 'This floor contains device markers you cannot edit', 403);
    const previousOpenings = openingPositions(oldFloor);
    const nextOpenings = openingPositions(floor);
    const attached = new Set(floor.markers.map(marker => marker.openingId));
    for (const marker of hidden) {
      requireValue(!marker.openingId || nextOpenings.has(marker.openingId) && !attached.has(marker.openingId)
        && nextOpenings.get(marker.openingId) === previousOpenings.get(marker.openingId),
        'This opening has a device marker you cannot edit', 403);
      floor.markers.push(marker);
    }
  }
  requireValue(next.floors.every(floor => floor.markers.length <= 1024)
    && next.floors.reduce((count, floor) => count + floor.markers.length, 0) <= 2048, 'Too many floor plan markers');
  requireValue(Buffer.byteLength(JSON.stringify(next)) <= floorPlanBodyLimit, 'The saved floor plan exceeds 8 MiB', 413);
}

export class FloorPlan {
  constructor(engine, security) {
    this.engine = engine;
    this.security = security;
    this.store = engine.s;
  }

  layout() {
    return this.store.get(layoutKey) ?? {version: 1, revision: 0, floors: []};
  }

  inventory(permissions) {
    const networks = new Map(this.store.networks().map(network => [network.id, network]));
    const zones = new Map();
    if (permissions.security) {
      for (const zone of this.security.zones()) {
        if (!zones.has(zone.deviceId)) zones.set(zone.deviceId, []);
        zones.get(zone.deviceId).push(zone);
      }
    }
    const allDevices = this.store.devices();
    const devices = allDevices.filter(device => permissions.health || zones.has(device.id)
      || permissions.security && networks.has(device.networkId) && networks.get(device.networkId).mode !== 'mqtt'
        && canPlaceDevice(device));
    return {devices, networks, zones, allDevices};
  }

  state(permissions, statusOnly = false) {
    const {devices, networks, zones} = this.inventory(permissions);
    const layout = this.layout();
    const placed = new Set(layout.floors.flatMap(floor => floor.markers.map(marker => marker.deviceId)));
    const included = statusOnly && !permissions.edit ? devices.filter(device => placed.has(device.id)) : devices;
    const live = included.some(device => !statusOnly || placed.has(device.id));
    const incidents = live && permissions.health ? this.store.all('SELECT * FROM incidents WHERE processed_at IS NULL') : [];
    const alarms = live && permissions.security ? new Set(this.security.activeIncidents().map(incident => incident.zoneId)) : new Set();
    const status = included.map(device => {
      const network = networks.get(device.networkId);
      const item = {id: device.id, name: device.name, networkLabel: network?.label ?? 'Missing broker', placeable: canPlaceDevice(device)};
      if (statusOnly && !placed.has(device.id)) {
        if (permissions.health && !item.placeable) {
          item.health = {status: device.retiredAt ? 'retired' : 'excluded'};
        }
        return item;
      }
      if (permissions.health) {
        const health = network ? this.engine.deviceState(device, network, incidents) : {status: 'unknown', issues: []};
        item.health = {status: health.status, battery: health.battery ?? null, lqi: health.lqi ?? null, issues: health.issues};
      }
      if (permissions.security) {
        const visibleZones = (zones.get(device.id) ?? []).map(zone => {
          const view = this.security.zoneState(zone);
          const contactOpen = /(?:^|\.)contact(?:$|_)/i.test(view.property) && view.known && typeof view.observedValue === 'boolean'
            ? !view.observedValue : null;
          const areas = view.areaStates.map(({areaId, areaName, mode, status, bypassed, homeExcluded}) => (
            {id: areaId, name: areaName, mode, status, bypassed, homeExcluded}));
          return {id: view.id, name: view.name, property: view.property, contactOpen, status: view.status, known: view.known, active: view.active,
            trouble: view.trouble, bypassed: view.bypassed, alarm: alarms.has(view.id), areas};
        });
        item.security = {alarm: visibleZones.some(zone => zone.alarm), zones: visibleZones};
      }
      return item;
    });
    if (statusOnly) return {revision: layout.revision, devices: status, permissions};
    const visibleIds = new Set(devices.map(device => device.id));
    const floors = layout.floors.map(floor => ({...floor, image: this.store.get(imageKey(floor.id)),
      markers: floor.markers.filter(marker => visibleIds.has(marker.deviceId))}));
    return {layout: {...layout, floors}, devices: status, permissions};
  }

  save(input, permissions, actor) {
    requireValue(permissions.edit, 'Floor plan editing is not permitted', 403);
    fields(input, ['version', 'revision', 'floors'], 'floor plan');
    requireValue(input.version === 1, 'Unsupported floor plan version');
    integer(input.revision, 0, Number.MAX_SAFE_INTEGER - 1, 'floor plan revision');
    return this.store.transaction(() => {
      const previous = this.layout();
      requireValue(input.revision === previous.revision, 'The floor plan changed. Reload it before saving.', 409);
      const {devices, allDevices} = this.inventory(permissions);
      const visibleDevices = new Map(devices.map(device => [device.id, device]));
      const currentIds = new Set(allDevices.map(device => device.id));
      const previousIds = new Set(previous.floors.flatMap(floor => floor.markers.map(marker => marker.deviceId)));
      const next = normalizeLayout(input, visibleDevices, previousIds);
      preserveHiddenMarkers(previous, next, visibleDevices, currentIds);
      for (const floor of previous.floors) {
        if (!next.floors.some(item => item.id === floor.id)) this.store.run('DELETE FROM settings WHERE key=?', imageKey(floor.id));
      }
      const floors = next.floors.map(({image, ...floor}) => {
        if (image === null) this.store.run('DELETE FROM settings WHERE key=?', imageKey(floor.id));
        else this.store.set(imageKey(floor.id), image);
        return floor;
      });
      this.store.set(layoutKey, {version: 1, revision: next.revision, floors});
      this.store.event('floor_plan_updated', 'Floor plan layout saved', {actor, at: this.engine.now()});
      return this.state(permissions);
    });
  }
}
