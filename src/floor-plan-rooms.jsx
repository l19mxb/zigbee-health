import React from 'react';
import './floor-plan-rooms.css';

const measurementKeys = ['temperature', 'humidity', 'illuminance'];
const activityKeys = ['motion', 'occupancy', 'presence'];
const compactNumber = new Intl.NumberFormat(undefined, {maximumFractionDigits: 1});
const healthLabels = {
  healthy: 'Healthy',
  issues: 'Health issues',
  offline: 'Offline',
  stale: 'Stale readings',
  retired: 'Retired',
  excluded: 'Excluded',
  unknown: 'Awaiting live readings',
};

function roomSources(room, devices, {showHealth, showSecurity, unavailable}) {
  return (room.deviceIds ?? []).map(id => {
    const device = devices.get(id);
    const readings = unavailable ? [] : (device?.readings ?? []).filter(({key, value}) =>
      showHealth && measurementKeys.includes(key) && Number.isFinite(value)
      || showSecurity && activityKeys.includes(key) && typeof value === 'boolean');
    return {
      id,
      device,
      readings,
      health: !unavailable && showHealth ? device?.health?.status : undefined,
      zones: !unavailable && showSecurity ? device?.security?.zones ?? [] : [],
      alarm: !unavailable && showSecurity && device?.security?.alarm,
    };
  });
}

function measurementValue(reading, value) {
  return reading.unit === '%' ? `${value}%` : `${value} ${reading.unit}`;
}

function compactMeasurement(readings, key) {
  const measurements = readings.filter(reading => reading.key === key);
  if (!measurements.length) return null;
  const values = measurements.map(reading => reading.value);
  const low = compactNumber.format(Math.min(...values));
  const high = compactNumber.format(Math.max(...values));
  const value = measurementValue(measurements[0], low === high ? low : `${low}–${high}`);
  return key === 'humidity' ? `${value} RH` : value;
}

function liveMetrics(readings) {
  const motion = readings.filter(({key}) => key === 'motion');
  const occupancy = readings.filter(({key}) => key === 'occupancy' || key === 'presence');
  const moving = motion.some(({value}) => value);
  const occupied = occupancy.some(({value}) => value);
  const activity = [];
  if (motion.length) activity.push(moving ? 'Motion' : 'Motion clear');
  if (occupancy.length) activity.push(occupied ? 'Occupancy' : 'Occupancy clear');
  const measurements = measurementKeys.map(key => compactMeasurement(readings, key)).filter(Boolean);
  return {activity, measurements, moving, occupied};
}

function roomIssue(sources, zones) {
  if (sources.some(source => source.health === 'offline')) {
    return {tone: 'warning', label: 'Device offline', metric: 'Offline'};
  }
  if (zones.some(zone => zone.trouble) || sources.some(source => source.health === 'issues')) {
    return {tone: 'warning', label: 'Device needs attention', metric: 'Trouble'};
  }
  if (sources.some(source => source.health === 'stale')) {
    return {tone: 'warning', label: 'Stale device readings', metric: 'Stale'};
  }
  if (sources.some(source => !source.device || ['unknown', 'retired', 'excluded'].includes(source.health))) {
    return {tone: 'unknown', label: 'Some device readings are unavailable', metric: 'Partial'};
  }
  return null;
}

function summarize(sources, {showHealth, showSecurity, unavailable}) {
  if (!sources.length) return {tone: 'neutral', label: 'No devices assigned', metrics: []};
  if (unavailable) return {tone: 'unknown', label: 'Live status unavailable', metrics: ['Unavailable']};
  if (!showHealth && !showSecurity) return {tone: 'neutral', label: 'Status layers hidden', metrics: []};

  const readings = sources.flatMap(source => source.readings);
  const zones = sources.flatMap(source => source.zones).filter(zone => zone.status !== 'disabled');
  const {activity, measurements, moving, occupied} = liveMetrics(readings);
  const metrics = [...activity, ...measurements];
  if (sources.some(source => source.alarm) || zones.some(zone => zone.alarm)) {
    return {tone: 'alarm', label: 'Security alarm', metrics: ['Alarm', ...metrics]};
  }
  if (zones.some(zone => zone.contactOpen === true)) {
    return {tone: 'open', label: 'Contact open', metrics: ['Open', ...metrics]};
  }
  if (zones.some(zone => zone.status === 'active' && !activityKeys.includes(zone.property))) {
    return {tone: 'open', label: 'Security zone active', metrics: ['Zone active', ...metrics]};
  }
  const issue = roomIssue(sources, zones);
  if (moving || occupied) {
    const state = moving ? 'Motion detected' : 'Occupancy detected';
    return issue
      ? {tone: 'motion', label: `${state} · ${issue.label}`, metrics: [...activity, issue.metric, ...measurements]}
      : {tone: 'motion', label: state, metrics};
  }
  if (issue) return {tone: issue.tone, label: issue.label, metrics: [issue.metric, ...metrics]};
  if (readings.length || zones.some(zone => zone.known)) {
    return {tone: 'good', label: 'Live room readings', metrics};
  }
  return {tone: 'unknown', label: 'Awaiting live readings', metrics: ['Awaiting readings']};
}

export function roomSummary(room, devices, options) {
  return summarize(roomSources(room, devices, options), options);
}

function readingValue(reading) {
  if (reading.key === 'motion') return reading.value ? 'Motion detected' : 'Clear';
  if (typeof reading.value === 'boolean') return reading.value ? 'Detected' : 'Clear';
  return measurementValue(reading, reading.value);
}

function zoneValue(zone) {
  if (zone.alarm) return 'Alarm';
  if (zone.status === 'disabled') return 'Disabled';
  if (zone.contactOpen === true) return 'Open';
  if (zone.contactOpen === false) return 'Closed';
  if (zone.trouble) return zone.trouble;
  if (zone.known) return zone.active ? 'Active' : 'Normal';
  return 'Awaiting a fresh report';
}

export function RoomDetails({room, devices, showHealth, showSecurity, unavailable}) {
  const options = {showHealth, showSecurity, unavailable};
  const sources = roomSources(room, devices, options);
  const summary = summarize(sources, options);
  const noLayers = !showHealth && !showSecurity;
  return (
    <div className="floor-room-details">
      <div className="floor-detail-heading">
        <span className="floor-status-label" data-tone={summary.tone}>{summary.label}</span>
      </div>
      {sources.length && unavailable ? <p className="notice warning">Live status is unavailable. Refresh the floor plan to try again.</p> : null}
      {sources.length && noLayers ? <p className="small muted">Turn on a status layer to see room readings.</p> : null}
      {sources.map(({id, device, health, readings, zones}) => (
        <section key={id} className="floor-room-device">
          <h3>{device?.name ?? 'Unavailable device'}</h3>
          {device?.networkLabel ? <p className="small muted">{device.networkLabel}</p> : null}
          {health || readings.length || zones.length ? (
            <dl>
              {health ? <><dt>Health</dt><dd>{healthLabels[health] ?? health}</dd></> : null}
              {readings.map(reading => (
                <React.Fragment key={reading.key}>
                  <dt>{reading.label}</dt>
                  <dd>{readingValue(reading)}</dd>
                </React.Fragment>
              ))}
              {zones.map(zone => (
                <React.Fragment key={zone.id}>
                  <dt>{zone.name}</dt>
                  <dd>{zoneValue(zone)}{zone.bypassed ? ' · Bypassed' : ''}</dd>
                </React.Fragment>
              ))}
            </dl>
          ) : null}
          {!unavailable && !noLayers && !readings.length && !zones.length
            ? <p className="small muted">No current room readings.</p>
            : null}
        </section>
      ))}
    </div>
  );
}
