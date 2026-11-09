import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {crc32,deflateSync} from 'node:zlib';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {SecurityEngine} from '../server/security.mjs';
import {FloorPlan} from '../server/floor-plan.mjs';
import {createApp} from '../server/http.mjs';
import {Accounts} from '../server/accounts.mjs';
import {Sessions} from '../server/sessions.mjs';
import {createBackup} from '../server/backup.mjs';

const full = {health: true, security: true, edit: true};
const securityOnly = {health: false, security: true, edit: true};
const healthOnly = {health: true, security: false, edit: true};
const password = 'synthetic-floor-plan-password';
const contactId = 'fixture-zigbee:0x00124b0000000001';
const hiddenId = 'fixture-mqtt:0x00124b0000000002';

function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length);
  chunk.write(type, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function png(padding = 0) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const comment = padding ? [pngChunk('tEXt', Buffer.concat([Buffer.from('Comment\0'), Buffer.alloc(padding, 65)]))] : [];
  const bytes = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), ...comment,
    pngChunk('IDAT', deflateSync(Buffer.alloc(18))), pngChunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + bytes.toString('base64');
}

function layout(image = png()) {
  return {version: 1, revision: 0, floors: [{id: 'level-one', name: 'Level one', width: 2, height: 2, image,
    rooms: [{id: 'fixture-room', name: 'Entry', points: [[0, 0], [1, 0], [1, 1], [0, 1]], label: [0.5, 0.5],
      openings: [{id: 'entry-door', name: 'Door', type: 'door', edgeIndex: 0, position: 0.5, size: 32, swing: false}]}],
    markers: [{deviceId: contactId, position: [0.25, 0.25]}, {deviceId: hiddenId, position: [0.5, 0], openingId: 'entry-door'}]},
  {id: 'level-two', name: 'Level two', width: 1000, height: 700, image: null, rooms: [], markers: []}]};
}

function fixture(store = new Store()) {
  let now = Date.now();
  const engine = new Engine(store, {clock: () => now});
  const security = new SecurityEngine(store, {clock: () => now});
  for (const [id, mode, label] of [['fixture-zigbee', 'zigbee2mqtt', 'Fixture Zigbee'], ['fixture-mqtt', 'mqtt', 'Fixture MQTT']]) {
    store.saveNetwork({id, mode, label, baseTopic: 'zigbee2mqtt', enabled: true, connected: true,
      connectedAt: now - 1000, bridgeState: 'online', host: 'private-broker.fixture.test',
      username: 'private-broker-user', password: 'private-broker-password'});
  }
  engine.ingest('fixture-zigbee', 'zigbee2mqtt/bridge/devices', [{ieee_address: '0x00124b0000000001', friendly_name: 'Fixture contact'}]);
  engine.ingest('fixture-zigbee', 'zigbee2mqtt/Fixture contact', {battery: 76, linkquality: 130});
  store.saveDevice({id: hiddenId, networkId: 'fixture-mqtt', ieee: '0x00124b0000000002', name: 'Fixture service', lastLiveAt: now});
  const area = security.saveArea({name: 'Fixture area', entryDelaySec: 0, exitDelaySec: 0}, 'Fixture');
  security.saveZone({name: 'Fixture detector', areaId: area.id, deviceId: contactId, property: 'contact', value: false, type: 'instant'}, 'Fixture');
  security.ingest(contactId, {contact: true});
  security.command(area.id, 'arm_away', {}, 'Fixture');
  now += 1000;
  security.ingest(contactId, {contact: false});
  return {store, engine, security, plan: new FloorPlan(engine, security)};
}

test('floor plans enforce revisions, preserve hidden attachments and project only permitted live layers', () => {
  const {store, engine, plan} = fixture();
  try {
    assert.deepEqual(plan.state(full).layout, {version: 1, revision: 0, floors: []});
    assert.deepEqual(store.all("SELECT key FROM settings WHERE key LIKE 'floorPlan%'"), []);
    const saved = plan.save(layout(), full, 'Fixture');
    assert.equal(saved.layout.revision, 1);
    assert.equal(saved.layout.floors[0].image, png());
    assert.equal(saved.layout.floors[1].image, null);
    assert.equal(saved.devices.find(device => device.id === contactId).security.alarm, true);
    assert.equal(saved.devices.find(device => device.id === contactId).health.battery, 76);

    const secure = plan.state(securityOnly);
    assert.deepEqual(secure.devices.map(device => device.id), [contactId]);
    assert.deepEqual(secure.layout.floors[0].markers.map(marker => marker.deviceId), [contactId]);
    assert.equal(secure.devices[0].health, undefined);
    assert.equal(secure.devices[0].security.zones[0].property, 'contact');
    assert.equal(secure.devices[0].security.zones[0].contactOpen, true);
    assert.equal(secure.devices[0].security.zones[0].observedValue, undefined);
    assert.equal(secure.devices[0].security.zones[0].areas[0].mode, 'away');
    assert.ok(plan.state(healthOnly).devices.every(device => device.security === undefined));
    for (const secret of ['private-broker.fixture.test', 'private-broker-user', 'private-broker-password', hiddenId]) {
      assert.equal(JSON.stringify(secure).includes(secret), false);
    }

    const renamed = structuredClone(secure.layout);
    renamed.floors[0].name = 'Renamed floor';
    const updated = plan.save(renamed, securityOnly, 'Fixture');
    assert.equal(updated.layout.revision, 2);
    assert.deepEqual(updated.layout.floors[0].markers.map(marker => marker.deviceId), [contactId]);
    assert.deepEqual(plan.state(full).layout.floors[0].markers[1], layout().floors[0].markers[1]);
    assert.throws(() => plan.save(renamed, securityOnly, 'Fixture'), {statusCode: 409});

    for (const change of [
      draft => draft.floors.shift(),
      draft => draft.floors[0].rooms[0].openings.pop(),
      draft => { draft.floors[0].rooms[0].openings[0].position = 0.6; },
      draft => { draft.floors[0].markers[0].openingId = 'entry-door'; },
      draft => draft.floors[0].markers.push({deviceId: hiddenId, position: [0.4, 0.4]})
    ]) {
      const attempted = structuredClone(updated.layout);
      change(attempted);
      assert.throws(() => plan.save(attempted, securityOnly, 'Fixture'), {statusCode: 403});
    }
    assert.equal(plan.layout().revision, 2);

    engine.ingest('fixture-zigbee', 'zigbee2mqtt/bridge/devices', [{ieee_address: '0x00124b0000000001', friendly_name: 'Renamed contact'}]);
    const originalGet = store.get;
    store.get = function (key) {
      assert.equal(key.startsWith('floorPlanImage:'), false, 'status poll must not read image settings');
      return originalGet.call(this, key);
    };
    const status = plan.state(securityOnly, true);
    assert.deepEqual(Object.keys(status).sort(), ['devices', 'permissions', 'revision']);
    assert.equal(status.devices[0].name, 'Renamed contact');
    assert.equal(status.devices[0].security.alarm, true);
  } finally {
    store.close();
  }
});

test('invalid geometry or images and failed writes leave the complete layout untouched', () => {
  const {store, plan} = fixture();
  try {
    for (const change of [
      draft => { draft.floors[0].markers[0].position = [-0.1, 1]; },
      draft => { draft.floors[0].rooms[0].openings[0].edgeIndex = 4; },
      draft => draft.floors[1].markers.push(draft.floors[0].markers[0]),
      draft => { draft.floors[0].image = 'data:image/svg+xml;base64,PHN2Zz4='; },
      draft => { draft.floors[0].image = 'https://other.fixture.test/background.png'; },
      draft => { draft.floors[0].width = 3; },
      draft => { draft.floors[0].image = draft.floors[0].image.slice(0, -4) + 'AAAA'; }
    ]) {
      const invalid = layout();
      change(invalid);
      assert.throws(() => plan.save(invalid, full, 'Fixture'), {statusCode: 400});
    }
    assert.equal(plan.layout().revision, 0);
    assert.deepEqual(store.all("SELECT key FROM settings WHERE key LIKE 'floorPlan%'"), []);
    const saved = plan.save(layout(), full, 'Fixture');
    const before = store.all('SELECT * FROM settings ORDER BY key');
    const event = store.event;
    store.event = () => { throw Error('Injected audit failure'); };
    assert.throws(() => plan.save({...saved.layout, floors: []}, full, 'Fixture'), /Injected audit failure/);
    assert.deepEqual(store.all('SELECT * FROM settings ORDER BY key'), before);
    store.event = event;
    assert.equal(plan.save({...saved.layout, floors: []}, full, 'Fixture').layout.revision, 2);
    assert.equal(store.get('floorPlanImage:level-one'), null);
  } finally {
    store.close();
  }
});

test('inactive devices stay unavailable for new placements while existing markers remain removable', () => {
  const {store, plan} = fixture();
  try {
    const contact = store.device(contactId);
    const service = store.device(hiddenId);
    const retire = () => store.saveDevice({...contact, retiredAt: Date.now()});
    const exclude = () => store.saveDevice({...service, disabled: true});
    retire();
    exclude();
    for (const statusOnly of [false, true]) {
      assert.equal(plan.state(securityOnly, statusOnly).devices.find(device => device.id === contactId).placeable, false);
      assert.equal(plan.state(healthOnly, statusOnly).devices.find(device => device.id === hiddenId).placeable, false);
    }
    const retired = layout();
    retired.floors[0].markers.pop();
    assert.throws(() => plan.save(retired, securityOnly, 'Fixture'), /Retired or excluded devices cannot be placed/);
    const excluded = layout();
    excluded.floors[0].markers.shift();
    assert.throws(() => plan.save(excluded, healthOnly, 'Fixture'), /Retired or excluded devices cannot be placed/);

    store.saveDevice(contact);
    store.saveDevice(service);
    const {layout: saved} = plan.save(layout(), full, 'Fixture');
    retire();
    exclude();
    const preserved = plan.save(saved, full, 'Fixture');
    assert.deepEqual(preserved.layout.floors[0].markers, saved.floors[0].markers);
    assert.ok(preserved.devices.every(device => device.placeable === false));
    const empty = {...preserved.layout, floors: []};
    assert.deepEqual(plan.save(empty, full, 'Fixture').layout.floors, []);
    assert.throws(() => plan.save({...saved, revision: empty.revision + 1}, full, 'Fixture'), /Retired or excluded devices cannot be placed/);
  } finally {
    store.close();
  }
});

test('native HTTP gates floor plans and rechecks editing permissions after the larger upload', async () => {
  const {store, engine, security, plan} = fixture();
  const accounts = new Accounts(store, {password});
  const sessions = new Sessions(store, accounts);
  const cookie = user => 'zh_session=' + sessions.issue(true, user).token;
  const admin = cookie(accounts.list()[0]);
  const reader = cookie(accounts.create({username: 'fixture-reader', password, permissions: ['viewHealth']}));
  const unrelated = cookie(accounts.create({username: 'fixture-reports', password, permissions: ['viewReports']}));
  const editorUser = accounts.create({username: 'fixture-editor', password, permissions: ['viewHealth', 'manageDevices']});
  const editor = cookie(editorUser);
  const server = createApp(engine, {security, password});
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const base = 'http://127.0.0.1:' + server.address().port;
    function request(route, {cookie: session, body, headers, defer = false} = {}) {
      let outgoing;
      const result = new Promise((resolve, reject) => {
        outgoing = http.request(base + '/api/' + route, {agent: false, method: body === undefined && !defer ? 'GET' : 'POST', headers: {
          ...(session ? {Cookie: session} : {}), ...(body !== undefined || defer ? {'Content-Type': 'application/json'} : {}), ...headers
        }}, response => {
          let raw = '';
          response.setEncoding('utf8');
          response.on('data', chunk => { raw += chunk; });
          response.on('end', () => {
            try { resolve({status: response.statusCode, headers: response.headers, data: JSON.parse(raw)}); }
            catch (error) { reject(error); }
          });
        });
        outgoing.on('error', error => reject(new Error(`HTTP fixture request ${route} failed`, {cause: error})));
        if (!defer) outgoing.end(body === undefined ? undefined : JSON.stringify(body));
      });
      return defer ? {outgoing, result} : result;
    }

    const anonymous = await request('floor-plan');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.data.error, 'Sign in to Zigbee Console');
    assert.equal((await request('floor-plan?status=1', {cookie: unrelated})).status, 403);
    assert.equal((await request('floor-plan', {cookie: reader, body: layout()})).status, 403);
    assert.equal((await request('floor-plan', {cookie: admin, body: layout(), headers: {Origin: 'https://other.fixture.test'}})).status, 403);
    assert.equal((await request('floor-plan', {cookie: admin, body: layout(), headers: {'Sec-Fetch-Site': 'cross-site'}})).status, 403);
    assert.equal((await request('floor-plan', {cookie: admin, body: layout(), headers: {'Content-Type': 'text/plain'}})).status, 415);
    const oversized = await request('floor-plan', {cookie: admin, body: layout(), headers: {'Content-Length': 9 * 1024 ** 2}});
    assert.equal(oversized.status, 413);
    const body = layout(png(70000));
    assert.ok(Buffer.byteLength(JSON.stringify(body)) > 65536);
    const attempts = await Promise.all([request('floor-plan', {cookie: admin, body}), request('floor-plan', {cookie: admin, body})]);
    assert.deepEqual(attempts.map(item => item.status).sort(), [200, 409]);
    const read = await request('floor-plan', {cookie: reader});
    assert.equal(read.headers['cache-control'], 'no-store');
    assert.equal(read.data.layout.floors[0].image, body.floors[0].image);
    assert.ok(read.data.devices.every(device => device.security === undefined));
    const state = await request('state', {cookie: admin});
    assert.ok(!JSON.stringify(state.data).includes('data:image/png'));
    assert.equal((await request('kiosk/floor-plan')).status, 401);

    const admitted = new Promise(resolve => server.prependOnceListener('request', () => setImmediate(resolve)));
    const upload = request('floor-plan', {cookie: editor, defer: true});
    upload.outgoing.write('{');
    await admitted;
    accounts.update({id: editorUser.id, enabled: false}, 'Fixture');
    upload.outgoing.end(JSON.stringify({...body, revision: 1, floors: []}).slice(1));
    assert.equal((await upload.result).status, 401);
    assert.equal(plan.layout().revision, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
});

test('the existing database backup includes floor metadata, marker IDs and image bytes', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'zigbee-floor-backup-'));
  const source = path.join(folder, 'source', 'health.db');
  const target = path.join(folder, 'backup');
  let store, restored;
  try {
    store = new Store(source);
    const {plan} = fixture(store);
    const tables = store.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const saved = plan.save(layout(), full, 'Fixture');
    await createBackup(source, target);
    restored = new Store(path.join(target, 'health.db'));
    const engine = new Engine(restored);
    const state = new FloorPlan(engine, new SecurityEngine(restored)).state(full);
    assert.deepEqual(state.layout, saved.layout);
    assert.deepEqual(restored.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"), tables);
  } finally {
    restored?.close();
    store?.close();
    const resolved = fs.realpathSync(folder);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('zigbee-floor-backup-'));
    fs.rmSync(resolved, {recursive: true, force: true});
  }
});
