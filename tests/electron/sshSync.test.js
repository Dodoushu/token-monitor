'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  collectSshDevice, createSshSyncRuntime, normalizeSshConnection, normalizeSshConnections, normalizeSshIntervalMs
} = require('../../src/electron/sshSync');
const { createSshAskpass } = require('../../src/electron/sshAskpass');

const alias = { id: 'devbox', label: 'Development', authMode: 'alias', alias: 'devbox' };
const passwordHost = { id: 'server', authMode: 'password', host: 'example.com', port: 2222, username: 'alice' };
const record = () => ({ deviceId: 'remote-device', today: { totalTokens: 12 }, month: { totalTokens: 24 }, allTime: { totalTokens: 48 }, secret: 'discard' });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); };
  return child;
}

test('SSH connection normalization is allowlisted and rejects argument injection', () => {
  const normalized = normalizeSshConnection({ ...alias, password: 'secret', arbitrary: true });
  assert.equal(normalized.remotePath, '~/token-monitor');
  assert.equal(normalized.password, undefined);
  assert.equal(normalized.arbitrary, undefined);
  for (const id of ['constructor', 'prototype', '__proto__', 'has.dot', 'x'.repeat(65)]) {
    assert.throws(() => normalizeSshConnection({ ...alias, id }));
  }
  for (const value of ['-oProxyCommand=evil', 'devbox\nother', 'host name', 'alice@host']) {
    assert.throws(() => normalizeSshConnection({ ...alias, alias: value }));
  }
  assert.throws(() => normalizeSshConnection({ ...passwordHost, port: 65536 }));
  assert.throws(() => normalizeSshConnection({ ...passwordHost, username: '-root' }));
  assert.throws(() => normalizeSshConnection({ ...alias, remotePath: '/tmp/a\ncommand' }));
  assert.equal(normalizeSshConnection(passwordHost).port, 2222);
  assert.equal(normalizeSshConnection({ ...passwordHost, host: '[2001:db8::1]' }).host, '[2001:db8::1]');
  assert.throws(() => normalizeSshConnection({ ...passwordHost, host: '[--invalid]' }));
});

test('saved SSH connections recover valid unique metadata up to twenty hosts', () => {
  assert.deepEqual(normalizeSshConnections(null), []);
  const saved = normalizeSshConnections([null, { ...alias, password: 'secret' }, alias,
    { ...alias, id: 'invalid', alias: '-option' },
    ...Array.from({ length: 25 }, (_, index) => ({ ...alias, id: `host-${index}` }))]);
  assert.equal(saved.length, 20);
  assert.equal(new Set(saved.map((entry) => entry.id)).size, 20);
  assert.equal(saved[0].id, 'devbox');
  assert.equal(saved[0].password, undefined);
});

test('SSH interval defaults to five minutes and clamps to 15 seconds through one day', () => {
  assert.equal(normalizeSshIntervalMs(undefined), 300000);
  assert.equal(normalizeSshIntervalMs('invalid'), 300000);
  assert.equal(normalizeSshIntervalMs(1), 15000);
  assert.equal(normalizeSshIntervalMs(90000000), 86400000);
  assert.equal(normalizeSshIntervalMs(45000), 45000);
});

test('password askpass contains no secret on disk and removes its private directory', async () => {
  const helper = createSshAskpass('never-write-me', { platform: 'linux' });
  const folder = path.dirname(helper.path);
  try {
    assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
    assert.equal(fs.statSync(helper.path).mode & 0o777, 0o700);
    assert.doesNotMatch(fs.readFileSync(helper.path, 'utf8'), /never-write-me/);
    assert.equal(helper.env.TOKEN_MONITOR_SSH_PASSWORD, 'never-write-me');
    const { execFile } = require('node:child_process');
    const result = await new Promise((resolve, reject) => execFile(helper.path, ['Password:'], {
      env: { ...process.env, ...helper.env }
    }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    assert.equal(result, 'never-write-me\n');
  } finally { helper.cleanup(); }
  assert.equal(fs.existsSync(folder), false);
});

test('alias collection preserves SSH config and quotes a remote path without a local shell', async () => {
  const child = fakeChild();
  let invocation;
  const pending = collectSshDevice({ ...alias, remotePath: "~/My folder/a'b;$(evil)" }, {}, {
    spawn: (...args) => { invocation = args; return child; }
  });
  assert.equal(invocation[0], 'ssh');
  assert.equal(invocation[2].shell, false);
  assert.ok(invocation[1].includes('BatchMode=yes'));
  assert.ok(invocation[1].includes('StrictHostKeyChecking=yes'));
  assert.ok(!invocation[1].includes('-F'));
  assert.equal(invocation[1].at(-2), 'devbox');
  assert.match(invocation[1].at(-1), /^cd -- "\$HOME"\/'My folder\/a'"'"'b;\$\(evil\)' && node src\/agent\/agent\.js --once --dry-run --limits=false$/);
  child.stdout.emit('data', Buffer.from(JSON.stringify(record())));
  child.emit('close', 0);
  const result = await pending;
  assert.equal(result.deviceId, 'remote-device');
  assert.equal(result.periods.today.totalTokens, 12);
  assert.equal(result.secret, undefined);
});

test('password collection passes the password only through child environment and cleans after close', async () => {
  const child = fakeChild();
  let invocation;
  const pending = collectSshDevice(passwordHost, { password: 'hunter-two' }, {
    platform: 'linux', spawn: (...args) => { invocation = args; return child; }
  });
  assert.equal(invocation[1].includes('hunter-two'), false);
  assert.equal(invocation[2].env.TOKEN_MONITOR_SSH_PASSWORD, 'hunter-two');
  assert.equal(invocation[2].env.SSH_ASKPASS_REQUIRE, 'force');
  const helper = invocation[2].env.SSH_ASKPASS;
  assert.ok(fs.existsSync(helper));
  child.stdout.emit('data', Buffer.from(JSON.stringify(record())));
  child.emit('close', 0);
  await pending;
  assert.equal(fs.existsSync(helper), false);
});

test('quoted remote paths execute literally even with shell metacharacters', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-ssh-path-'));
  const child = fakeChild();
  let command;
  try {
    const remotePath = path.join(root, "folder'a;$(touch injected)");
    fs.mkdirSync(remotePath);
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(record())}'\n`, { mode: 0o700 });
    const pending = collectSshDevice({ ...alias, remotePath }, {}, { spawn: (_file, args) => {
      command = args.at(-1);
      return child;
    } });
    const { execFile } = require('node:child_process');
    const stdout = await new Promise((resolve, reject) => execFile('/bin/sh', ['-c', command], {
      cwd: root, env: { ...process.env, PATH: bin }
    }, (error, output) => error ? reject(error) : resolve(output)));
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0);
    assert.equal((await pending).periods.allTime.totalTokens, 48);
    assert.equal(fs.existsSync(path.join(root, 'injected')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('SSH failures classify authentication and host-key errors without leaking output', async () => {
  for (const [stderr, expected] of [
    ['Permission denied: password=hunter-two', 'ssh-auth-failed'],
    ['Host key verification failed.', 'ssh-host-key'],
    ['node: command not found', 'ssh-agent-unavailable']
  ]) {
    const child = fakeChild();
    const pending = collectSshDevice(alias, {}, { spawn: () => child });
    child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', 255);
    await assert.rejects(pending, (error) => error.code === expected && !error.message.includes('hunter-two'));
  }
});

test('SSH cancellation remains pending until close and malformed output is rejected', async () => {
  const controller = new AbortController();
  const child = fakeChild();
  let settled = false;
  const pending = collectSshDevice(alias, { signal: controller.signal }, { spawn: () => child });
  pending.catch(() => { settled = true; });
  controller.abort();
  await flush();
  assert.equal(settled, false);
  assert.deepEqual(child.signals, ['SIGTERM']);
  child.emit('close', null);
  await assert.rejects(pending, { code: 'ssh-cancelled' });

  for (const output of ['not json', '{}', JSON.stringify({ ...record(), month: undefined })]) {
    const invalid = fakeChild();
    const read = collectSshDevice(alias, {}, { spawn: () => invalid });
    invalid.stdout.emit('data', Buffer.from(output));
    invalid.emit('close', 0);
    await assert.rejects(read, { code: 'ssh-invalid-output' });
  }
});

test('SSH output overflow terminates the child and waits for close', async () => {
  const child = fakeChild();
  const pending = collectSshDevice(alias, { maxOutputBytes: 8 }, { spawn: () => child });
  child.stdout.emit('data', Buffer.from('too much output'));
  assert.deepEqual(child.signals, ['SIGTERM']);
  child.emit('close', null);
  await assert.rejects(pending, { code: 'ssh-output-limit' });
});

test('SSH timeout and spawn errors are classified without exposing subprocess details', async () => {
  const child = fakeChild();
  let expire;
  const pending = collectSshDevice(alias, { timeoutMs: 1000 }, {
    spawn: () => child, setTimeout: (callback) => { expire = callback; return {}; }, clearTimeout: () => {}
  });
  expire();
  assert.deepEqual(child.signals, ['SIGTERM']);
  child.emit('close', null);
  await assert.rejects(pending, { code: 'ssh-timeout' });

  const missing = fakeChild();
  const failed = collectSshDevice(alias, {}, { spawn: () => missing });
  missing.emit('error', Object.assign(new Error('private details'), { code: 'ENOENT' }));
  missing.emit('close', -2);
  await assert.rejects(failed, (error) => error.code === 'ssh-unavailable' && !error.message.includes('private'));
});

test('an unconfirmed forced close stops runtime admission and makes stop fail closed', async () => {
  const child = fakeChild();
  const terminationTimers = [];
  let count = 0;
  const runtime = createSshSyncRuntime({ connections: [alias], collect: (connection, options) => {
    count += 1;
    return collectSshDevice(connection, options, {
      spawn: () => child,
      terminationOptions: { setTimeout: (fn) => { terminationTimers.push(fn); return {}; }, clearTimeout: () => {} }
    });
  } });
  const starting = runtime.start();
  await flush();
  const stopping = runtime.stop();
  terminationTimers[0]();
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  terminationTimers[1]();
  await starting;
  await assert.rejects(stopping, { code: 'termination-unconfirmed' });
  await assert.rejects(runtime.start(), { code: 'termination-unconfirmed' });
  assert.equal(count, 1);
  assert.equal(runtime.getStatus().running, false);
  child.emit('close', null);
});

test('runtime starts immediately, coalesces concurrent refreshes and polls on configured interval', async () => {
  const calls = [];
  const records = [];
  const timers = [];
  const first = deferred();
  const runtime = createSshSyncRuntime({
    connections: [alias], intervalMs: 45000,
    collect: async (connection) => { calls.push(connection.id); return calls.length === 1 ? first.promise : record(); },
    onRecord: (value, connection) => records.push([value.deviceId, connection.id])
  }, { setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; }, clearTimeout: () => {} });
  const started = runtime.start();
  const refreshed = runtime.refresh();
  await flush();
  assert.equal(calls.length, 1);
  first.resolve(record());
  await Promise.all([started, refreshed]);
  assert.equal(calls.length, 1);
  assert.deepEqual(records, [['remote-device', 'devbox']]);
  assert.equal(timers.at(-1).ms, 45000);
  await timers.at(-1).fn();
  assert.equal(calls.length, 2);
  assert.ok(runtime.getStatus().lastSuccessAt);
  await runtime.stop();
});

test('runtime stop aborts collection, waits for completion, and discards late records', async () => {
  const pending = deferred();
  const records = [];
  let signal;
  let stopped = false;
  const runtime = createSshSyncRuntime({ connections: [alias], collect: (_connection, options) => {
    signal = options.signal;
    return pending.promise;
  }, onRecord: (value) => records.push(value) });
  const started = runtime.start();
  await flush();
  const stopping = runtime.stop().then(() => { stopped = true; });
  assert.equal(signal.aborted, true);
  await flush();
  assert.equal(stopped, false);
  pending.resolve(record());
  await Promise.all([started, stopping]);
  assert.equal(records.length, 0);
  assert.equal(runtime.getStatus().running, false);
});

test('status callbacks may request refresh without opening a second collection', async () => {
  const pending = deferred();
  let count = 0;
  let runtime;
  runtime = createSshSyncRuntime({ connections: [alias], collect: () => { count += 1; return pending.promise; },
    onStatus: (status) => { if (status.hosts.some((host) => host.running)) void runtime.refresh(); } });
  const started = runtime.start();
  await flush();
  assert.equal(count, 1);
  pending.resolve(record());
  await started;
  await runtime.stop();
});

test('one failed host does not stop other hosts and passwords stay out of status', async () => {
  const errors = [];
  const records = [];
  const runtime = createSshSyncRuntime({ connections: [passwordHost, alias], getPassword: () => 'private',
    collect: async (connection, options) => {
      if (connection.id === 'server') {
        assert.equal(options.password, 'private');
        throw new Error('private could be in an arbitrary transport error');
      }
      return record();
    }, onRecord: (value) => records.push(value), onStatus: (value) => errors.push(value) });
  await runtime.start();
  assert.equal(records.length, 1);
  const status = runtime.getStatus();
  assert.equal(status.hosts[0].error, 'ssh-failed');
  assert.ok(status.hosts[1].lastSuccessAt);
  assert.doesNotMatch(JSON.stringify(errors), /private/);
  await runtime.stop();
});

test('SSH askpass rejects passwords that cannot be represented and unsupported platform explicitly', () => {
  assert.throws(() => createSshAskpass('a\0b'), { code: 'ssh-password-invalid' });
  assert.throws(() => createSshAskpass('password', { platform: 'win32' }), { code: 'ssh-password-unsupported' });
});
