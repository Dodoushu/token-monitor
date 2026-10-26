'use strict';

const { aggregateDevices, normalizeDeviceRecord } = require('../shared/usage');
const { syncPayload } = require('../shared/syncPayload');
const { composeLocalSyncSummary } = require('./syncDisplayStats');

function identity(connection) {
  const { id, authMode, alias, host, port, username, remotePath } = connection;
  return JSON.stringify([id, authMode, alias, host, port, username, remotePath]);
}

function createSshDeviceSnapshots({ getConnections, getIntervalMs, now = Date.now }) {
  const snapshots = new Map();
  function accept(record, connection) {
    // Reuse the existing wire projection: remote session text and local-only
    // provenance never become renderer state. The connection owns device
    // identity so identical hostnames cannot overwrite this machine.
    const safe = normalizeDeviceRecord({
      ...syncPayload(record),
      deviceId: 'ssh:' + connection.id,
      receivedAt: new Date(now()).toISOString(),
      agentRuntime: 'ssh'
    });
    snapshots.set(connection.id, { identity: identity(connection), record: safe });
  }
  function records(local) {
    const rows = local ? [local] : [];
    const connections = getConnections();
    const activeIds = new Set(connections.map((connection) => connection.id));
    for (const id of snapshots.keys()) if (!activeIds.has(id)) snapshots.delete(id);
    for (const connection of connections) {
      const snapshot = snapshots.get(connection.id);
      if (snapshot?.identity === identity(connection)) rows.push(snapshot.record);
      else snapshots.delete(connection.id);
    }
    return rows;
  }
  function stats(local) {
    const nowMs = now();
    const staleAfterMs = Math.max(600000, getIntervalMs() * 2);
    const remote = { ...aggregateDevices(records(null), staleAfterMs, nowMs), staleAfterMs };
    // Match normal Hub presentation: local all-time sessions stay lazy instead
    // of being normalized again on every live local tick.
    const result = composeLocalSyncSummary(remote, local, { nowMs });
    const labels = new Map(getConnections().map((connection) => ['ssh:' + connection.id, connection.label || connection.alias || connection.host]));
    for (const device of result.devices) {
      if (labels.has(device.deviceId)) device.displayName = labels.get(device.deviceId);
    }
    return result;
  }
  return { accept, records, stats };
}

module.exports = { createSshDeviceSnapshots };
