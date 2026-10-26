'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSshDeviceSnapshots } = require('../../src/electron/sshSyncStats');

function record(id, tokens) {
  return { deviceId: id, hostname: id, updatedAt: '2026-10-26T00:00:00Z',
    today: { totalTokens: tokens }, month: { totalTokens: tokens }, allTime: { totalTokens: tokens } };
}

test('SSH records have stable local identities and never replace the local machine with the same hostname', () => {
  let connections = [{ id: 'remote', label: 'Development', host: 'host' }];
  const snapshots = createSshDeviceSnapshots({ getConnections: () => connections, getIntervalMs: () => 300000, now: () => Date.parse('2026-10-26T00:00:00Z') });
  snapshots.accept(record('same-hostname', 30), connections[0]);
  const local = record('same-hostname', 10);
  const records = snapshots.records(local);
  assert.deepEqual(records.map((row) => row.deviceId), ['same-hostname', 'ssh:remote']);
  assert.equal(records[1].hostname, 'same-hostname');
  assert.equal(snapshots.stats(local).periods.today.totalTokens, 40);
  assert.equal(snapshots.stats(local).devices.find((device) => device.deviceId === 'ssh:remote').displayName, 'Development');
  snapshots.accept(record('same-hostname', 35), connections[0]);
  assert.equal(snapshots.stats(local).periods.today.totalTokens, 45);
  connections = [{ ...connections[0], host: 'different-host' }];
  assert.equal(snapshots.stats(local).periods.today.totalTokens, 10);
});

test('removed connections disappear and a retained snapshot becomes stale at the polling deadline', () => {
  let time = Date.parse('2026-10-26T00:00:00Z');
  let connections = [{ id: 'remote', host: 'host' }];
  const snapshots = createSshDeviceSnapshots({ getConnections: () => connections, getIntervalMs: () => 600000, now: () => time });
  snapshots.accept(record('remote', 30), connections[0]);
  time += 20 * 60 * 1000 + 1;
  assert.equal(snapshots.stats(null).devices[0].stale, true);
  assert.equal(snapshots.stats(null).periods.today.totalTokens, 30);
  connections = [];
  assert.equal(snapshots.records(null).length, 0);
});

test('SSH aggregation retains locally collected account limits even before any remote record arrives', () => {
  const now = Date.parse('2026-10-26T00:00:00Z');
  const local = record('local', 10);
  local.limits = { updatedAt: new Date(now).toISOString(), providers: [{ provider: 'codex', accountKey: 'local-account',
    status: 'ok', source: 'rpc', updatedAt: new Date(now).toISOString(),
    windows: [{ kind: 'session', label: 'Session', usedPercent: 20 }] }] };
  const snapshots = createSshDeviceSnapshots({ getConnections: () => [], getIntervalMs: () => 300000, now: () => now });
  const stats = snapshots.stats(local);
  assert.equal(stats.limits.providers.length, 1);
  assert.equal(stats.limits.providers[0].provider, 'codex');
  assert.equal(stats.limits.providers[0].windows[0].usedPercent, 20);
});
