'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { classifySettingsChange } = require('../../src/electron/runtimeConfig');
const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
function extract(start, end) {
  const offset = source.indexOf(start);
  return source.slice(offset, source.indexOf(end, offset));
}

test('a changed polling interval restarts the SSH mode with the new cadence', () => {
  assert.equal(classifySettingsChange({ hubMode: 'ssh', sshPollIntervalMs: 300000 }, { hubMode: 'ssh', sshPollIntervalMs: 45000 }).modeStructural, true);
});

test('the quit stop path sends cancellation synchronously before waiting for close', async () => {
  let stopped = false;
  let close;
  const pending = new Promise((resolve) => { close = resolve; });
  const sandbox = vm.createContext({ sshRuntimeHandle: { stop() { stopped = true; return pending; } }, sshStopPromise: Promise.resolve() });
  vm.runInContext(extract('function stopSshRuntime() {', '\nasync function startSshCollector() {'), sandbox);
  const stoppedPromise = sandbox.stopSshRuntime();
  assert.equal(stopped, true);
  assert.equal(sandbox.sshRuntimeHandle, null);
  close();
  await stoppedPromise;
});

test('a failed SSH close barrier blocks SSH replacements while local mode can recover', async () => {
  const events = [];
  const sandbox = vm.createContext({
    sshSettingsService: null,
    settings: { hubMode: 'local' }, hubModeGeneration: 0, modeQueue: Promise.resolve(),
    console: { log() {} }, getSyncContentRuntime: () => ({ invalidate() {} }),
    advanceMacWidgetProducerAndSourceEpoch() {}, clearLatestHubStatsCache() {},
    stopIcloudRuntime: async () => {}, stopSshRuntime: async () => { throw new Error('termination-unconfirmed'); },
    stopLocalCollector() {}, stopStatsStream() {}, stopHostStats() {}, stopSyncCollector() {},
    syncStatsPublication: { cancel() {} }, stopEmbeddedHub: async () => {},
    effectiveHubConfig: () => ({}), reconcileSharedSubscriptions() {},
    recordDiagnosticEvent: () => events.push('diagnostic'),
    startLocalCollector: () => events.push('local'), startSshCollector: async () => events.push('ssh')
  });
  vm.runInContext(extract('function startMode() {', '\n// Reconciled on every mode change'), sandbox);
  sandbox.startMode();
  await sandbox.modeQueue;
  assert.ok(events.includes('local'));
  sandbox.settings.hubMode = 'ssh';
  sandbox.startMode();
  await sandbox.modeQueue;
  assert.equal(events.includes('ssh'), false);
});

test('switching away while an old SSH process stops cannot start another remote connection', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let starts = 0;
  const sandbox = vm.createContext({ settings: { hubMode: 'ssh' }, hubModeGeneration: 1,
    stopSshRuntime: () => pending, startLocalCollector: () => { starts += 1; } });
  vm.runInContext(extract('async function startSshCollector() {', '\nlet deviceRuntimeHandle = null;'), sandbox);
  const start = sandbox.startSshCollector();
  sandbox.settings.hubMode = 'local';
  sandbox.hubModeGeneration += 1;
  release();
  await start;
  assert.equal(starts, 0);
});
