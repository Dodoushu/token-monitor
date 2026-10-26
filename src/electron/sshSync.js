'use strict';

const { spawn } = require('node:child_process');
const { isIP } = require('node:net');
const { normalizeDeviceRecord } = require('../shared/usage');
const { createSubprocessTermination, terminationUnconfirmedError } = require('../shared/subprocessTermination');
const { createSshAskpass } = require('./sshAskpass');

const DEFAULT_SSH_INTERVAL_MS = 5 * 60 * 1000;
const MIN_SSH_INTERVAL_MS = 15 * 1000;
const MAX_SSH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SSH_TIMEOUT_MS = 180 * 1000;
const DEFAULT_SSH_OUTPUT_BYTES = 32 * 1024 * 1024;
const ERROR_MESSAGES = {
  'ssh-cancelled': 'SSH collection was cancelled.',
  'ssh-unavailable': 'OpenSSH was not found. Install the system SSH client.',
  'ssh-auth-failed': 'SSH authentication failed. Check the account, password, key or agent.',
  'ssh-host-key': 'Verify and trust this host in a terminal before collecting it.',
  'ssh-agent-unavailable': 'Check the remote Token Monitor path, Node.js and installed project dependencies.',
  'ssh-timeout': 'SSH collection timed out. Check the connection and remote collector.',
  'ssh-output-limit': 'The remote collector exceeded the output limit.',
  'ssh-invalid-output': 'The remote collector did not return a complete device record.',
  'ssh-password-invalid': 'Enter a non-empty password without line breaks.',
  'ssh-password-unsupported': 'Password authentication requires macOS or Linux; use an SSH alias on Windows.',
  'ssh-failed': 'SSH collection failed. Check the host and remote Token Monitor setup.'
};

function sshError(code) {
  const error = new Error(ERROR_MESSAGES[code] || ERROR_MESSAGES['ssh-failed']);
  error.code = code;
  return error;
}

function normalizeSshIntervalMs(value) {
  const numeric = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(numeric)) return DEFAULT_SSH_INTERVAL_MS;
  return Math.min(MAX_SSH_INTERVAL_MS, Math.max(MIN_SSH_INTERVAL_MS, Math.round(numeric)));
}

function invalid(field) {
  const error = new Error(`Invalid SSH ${field}.`);
  error.code = 'ssh-invalid-connection';
  error.field = field;
  throw error;
}

function normalizeSshConnection(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('connection');
  const id = String(raw.id || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)
    || ['__proto__', 'constructor', 'prototype'].includes(id)) invalid('id');
  const authMode = raw.authMode || 'alias';
  if (!['alias', 'password'].includes(authMode)) invalid('authentication mode');
  const alias = String(raw.alias || '').trim();
  const host = String(raw.host || '').trim();
  const username = String(raw.username || '').trim();
  const port = raw.port === undefined || raw.port === '' ? 22 : Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid('port');
  // These values become individual OpenSSH arguments, with no local shell.
  // Forbid option prefixes and user@host/URI forms so each field owns one fact.
  if (authMode === 'alias' && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/.test(alias)) invalid('alias');
  if (authMode === 'password') {
    const address = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    if (host.length > 253 || (!isIP(address) && !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host))) invalid('host');
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(username)) invalid('username');
  }
  const label = String(raw.label || (authMode === 'alias' ? alias : host)).trim();
  if (!label || label.length > 120 || /[\x00-\x1f\x7f]/.test(label)) invalid('label');
  const remotePath = String(raw.remotePath || '~/token-monitor').trim();
  if (!remotePath || remotePath.length > 4096 || /[\x00-\x1f\x7f]/.test(remotePath)) invalid('remote path');
  return { id, label, authMode, alias: authMode === 'alias' ? alias : '',
    host: authMode === 'password' ? host : '', port, username: authMode === 'password' ? username : '', remotePath };
}

// Disk recovery is tolerant, while editing one connection remains strict.
function normalizeSshConnections(value) {
  const connections = [];
  const seen = new Set();
  if (!Array.isArray(value)) return connections;
  for (const raw of value) {
    if (connections.length >= 20) break;
    try {
      const connection = normalizeSshConnection(raw);
      if (seen.has(connection.id)) continue;
      seen.add(connection.id);
      connections.push(connection);
    } catch (_) { /* Keep the other valid saved hosts usable. */ }
  }
  return connections;
}

function quoteShell(value) { return `'${value.replace(/'/g, `'"'"'`)}'`; }

function remoteCommand(remotePath) {
  const directory = remotePath === '~' ? '"$HOME"' : remotePath.startsWith('~/')
    ? `"$HOME"/${quoteShell(remotePath.slice(2))}` : quoteShell(remotePath);
  return `cd -- ${directory} && node src/agent/agent.js --once --dry-run --limits=false`;
}

function classifyFailure(stderr) {
  if (/host key verification failed|remote host identification has changed|no .* host key is known/i.test(stderr)) return 'ssh-host-key';
  if (/permission denied|authentication failed|too many authentication failures/i.test(stderr)) return 'ssh-auth-failed';
  if (/no such file or directory|command not found|cannot find module|can't cd|cannot cd/i.test(stderr)) return 'ssh-agent-unavailable';
  return 'ssh-failed';
}

function parseDevice(text) {
  let record;
  try { record = JSON.parse(text); } catch (_) { throw sshError('ssh-invalid-output'); }
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || typeof record.deviceId !== 'string' || !record.deviceId.trim()
    || !['today', 'month', 'allTime'].every((period) => {
      const value = record[period] || record.periods?.[period];
      return value && typeof value === 'object' && !Array.isArray(value);
    })) throw sshError('ssh-invalid-output');
  try { return normalizeDeviceRecord(record); }
  catch (_) { throw sshError('ssh-invalid-output'); }
}

// The Promise is the close barrier: SIGTERM alone never permits a replacement
// scan. An unconfirmed forced close poisons the runtime instead of polling again.
function collectSshDevice(rawConnection, options = {}, deps = {}) {
  let connection;
  let askpass;
  try {
    connection = normalizeSshConnection(rawConnection);
    if (options.signal?.aborted) return Promise.reject(sshError('ssh-cancelled'));
    if (connection.authMode === 'password') askpass = createSshAskpass(options.password, deps);
  } catch (error) { return Promise.reject(error); }
  const args = ['-T', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectionAttempts=1',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ForwardX11=no'];
  if (connection.authMode === 'alias') args.push('-o', 'BatchMode=yes');
  else args.push('-o', 'BatchMode=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'PubkeyAuthentication=no',
    '-o', 'PreferredAuthentications=password,keyboard-interactive', '-p', String(connection.port), '-l', connection.username);
  args.push('--', connection.authMode === 'alias' ? connection.alias : connection.host, remoteCommand(connection.remotePath));
  const run = deps.spawn || spawn;
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = run('ssh', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...(deps.env || process.env), ...(askpass?.env || {}) } });
    } catch (_) {
      askpass?.cleanup();
      reject(sshError('ssh-unavailable'));
      return;
    }
    let failure = null;
    let finished = false;
    let timer;
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let stderrBytes = 0;
    const maxBytes = Math.max(1, Number(options.maxOutputBytes) || DEFAULT_SSH_OUTPUT_BYTES);
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_SSH_TIMEOUT_MS);
    const finish = (error, record) => {
      if (finished) return;
      finished = true;
      clearTimer(timer);
      options.signal?.removeEventListener('abort', abort);
      try { askpass?.cleanup(); } catch (_) { /* The file contains no secret. */ }
      if (error) reject(error); else resolve(record);
    };
    const termination = createSubprocessTermination(child, {
      ...deps.terminationOptions,
      onUnconfirmed: () => finish(terminationUnconfirmedError(failure, 'SSH collection'))
    });
    const fail = (code) => { failure ||= sshError(code); termination.request(); };
    const abort = () => fail('ssh-cancelled');
    timer = setTimer(() => fail('ssh-timeout'), timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      if (failure || finished) return;
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) { fail('ssh-output-limit'); return; }
      stdout.push(buffer);
    });
    child.stderr.on('data', (chunk) => {
      if (failure || finished) return;
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) { fail('ssh-output-limit'); return; }
      // Only retained for classification, never copied into UI/errors/logs.
      if (stderrBytes < 128 * 1024) { stderr.push(buffer.subarray(0, 128 * 1024 - stderrBytes)); stderrBytes += buffer.length; }
    });
    child.on('error', (error) => { failure ||= sshError(error.code === 'ENOENT' ? 'ssh-unavailable' : 'ssh-failed'); });
    child.on('close', (code) => {
      termination.confirmClosed();
      if (failure) { finish(failure); return; }
      if (code !== 0) { finish(sshError(classifyFailure(Buffer.concat(stderr).toString('utf8')))); return; }
      try { finish(null, parseDevice(Buffer.concat(stdout).toString('utf8'))); }
      catch (error) { finish(error); }
    });
    if (options.signal?.aborted) abort();
  });
}

function createSshSyncRuntime(options = {}, deps = {}) {
  const connections = (options.connections || []).map(normalizeSshConnection);
  if (new Set(connections.map((connection) => connection.id)).size !== connections.length) invalid('duplicate id');
  const intervalMs = normalizeSshIntervalMs(options.intervalMs);
  const collect = options.collect || collectSshDevice;
  const setTimer = deps.setTimeout || setTimeout;
  const clearTimer = deps.clearTimeout || clearTimeout;
  const now = deps.now || (() => new Date().toISOString());
  let running = false;
  let timer = null;
  let active = null;
  let controller = null;
  let generation = 0;
  let fatalError = null;
  const status = { running: false, lastAttemptAt: null, lastSuccessAt: null, error: null,
    hosts: connections.map(({ id, label }) => ({ id, label, running: false, lastAttemptAt: null, lastSuccessAt: null, error: null })) };
  const getStatus = () => ({ ...status, hosts: status.hosts.map((host) => ({ ...host })) });
  const publish = () => { try { options.onStatus?.(getStatus()); } catch (_) {} };
  const current = (captured) => running && captured === generation;
  function schedule(captured) {
    if (!current(captured) || fatalError) return;
    timer = setTimer(() => { timer = null; return refresh(); }, intervalMs);
    timer?.unref?.();
  }
  function refresh() {
    if (fatalError) return Promise.reject(fatalError);
    if (!running) return Promise.resolve(getStatus());
    if (active) return active;
    if (timer !== null) { clearTimer(timer); timer = null; }
    const captured = generation;
    controller = new AbortController();
    const signal = controller.signal;
    // Assign the flight before callbacks can synchronously trigger a refresh.
    active = Promise.resolve().then(async () => {
      for (let index = 0; index < connections.length && current(captured); index += 1) {
        const connection = connections[index];
        const host = status.hosts[index];
        host.running = true;
        host.error = null;
        status.lastAttemptAt = host.lastAttemptAt = now();
        publish();
        try {
          const password = connection.authMode === 'password' ? await options.getPassword?.(connection.id) : undefined;
          if (!current(captured)) break;
          const record = await collect(connection, { password, signal });
          if (!current(captured)) break;
          await options.onRecord?.(record, connection);
          if (!current(captured)) break;
          status.lastSuccessAt = host.lastSuccessAt = now();
        } catch (error) {
          if (error.code === 'termination-unconfirmed') {
            fatalError = error;
            status.error = host.error = error.code;
            running = status.running = false;
          } else if (current(captured)) host.error = Object.hasOwn(ERROR_MESSAGES, error.code) ? error.code : 'ssh-failed';
        } finally {
          host.running = false;
          if (current(captured) || fatalError) {
            status.error = status.hosts.find((entry) => entry.error)?.error || null;
            publish();
          }
        }
      }
      return getStatus();
    }).finally(() => { active = null; controller = null; schedule(captured); });
    return active;
  }
  function start() {
    if (fatalError) return Promise.reject(fatalError);
    if (!running) { running = status.running = true; generation += 1; publish(); }
    return refresh();
  }
  async function stop() {
    running = status.running = false;
    generation += 1;
    if (timer !== null) { clearTimer(timer); timer = null; }
    controller?.abort();
    publish();
    await active;
    if (fatalError) throw fatalError;
    return getStatus();
  }
  return { start, refresh, stop, getStatus };
}

module.exports = {
  DEFAULT_SSH_INTERVAL_MS, MIN_SSH_INTERVAL_MS, MAX_SSH_INTERVAL_MS,
  normalizeSshConnection, normalizeSshConnections, normalizeSshIntervalMs, collectSshDevice, createSshSyncRuntime
};
