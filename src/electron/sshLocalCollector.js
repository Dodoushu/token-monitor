'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { locateBundledBinary, computePeriodWindows } = require('../shared/collector');
const { extractUsageFromTokscale } = require('../shared/usage');
const { normalizeHistory, parseGraphResult, localDayKey } = require('../shared/history');
const { createSubprocessTermination, terminationUnconfirmedError } = require('../shared/subprocessTermination');
const { appVersion } = require('../shared/appVersion');

const FILE_CLIENTS = new Set(['claude', 'codex', 'kimi', 'droid', 'qwen', 'gemini', 'openclaw', 'pi', 'grok', 'commandcode', 'codebuddy', 'dsh', 'omp', 'amp']);
function scanError(code = 'ssh-local-scan-failed') {
  const error = new Error(code);
  error.code = code;
  return error;
}

function scanEnvironment(home, inherited = process.env) {
  const env = { HOME: home, USERPROFILE: home,
    XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'), TOKSCALE_CONFIG_DIR: path.join(home, '.config', 'tokscale'),
    CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    KIMI_CODE_HOME: path.join(home, '.kimi-code'), NO_COLOR: '1' };
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TMP', 'TEMP', 'TMPDIR', 'LANG', 'TZ']) {
    if (typeof inherited[key] === 'string') env[key] = inherited[key];
  }
  return env;
}

function runScannerJson(binary, args, { env, signal, timeoutMs = 120000 } = {}) {
  if (signal?.aborted) return Promise.reject(scanError('ssh-cancelled'));
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(binary, args, { env, cwd: env.HOME, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (_) { reject(scanError()); return; }
    let finished = false;
    let failure = null;
    let bytes = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const termination = createSubprocessTermination(child, {
      onUnconfirmed: () => finish(terminationUnconfirmedError(failure, 'SSH local scanner'))
    });
    const fail = (code) => { failure ||= scanError(code); termination.request(); };
    const abort = () => fail('ssh-cancelled');
    const timer = setTimeout(() => fail('ssh-local-scan-failed'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      if (failure || finished) return;
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) { fail('ssh-local-scan-failed'); return; }
      chunks.push(Buffer.from(chunk));
    });
    // Drain diagnostics without disclosing paths, transcript fragments or config.
    child.stderr.on('data', () => {});
    child.on('error', () => { failure ||= scanError(); });
    child.on('close', (code) => {
      termination.confirmClosed();
      if (failure || code !== 0) { finish(failure || scanError()); return; }
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (_) { finish(scanError()); }
    });
    if (signal?.aborted) abort();
  });
}

async function collectSshMirror({ home, connection, signal, remotePlatform = 'ssh-posix', clients = [] }, deps = {}) {
  const selected = [...new Set(clients.filter(client => FILE_CLIENTS.has(client)))];
  if (selected.length === 0) throw scanError('ssh-no-session-data');
  if (!path.isAbsolute(home)) throw scanError();
  const binary = (deps.resolveBinary || (() => locateBundledBinary()?.path))();
  if (!binary) throw scanError();
  const env = scanEnvironment(home, deps.env);
  const run = deps.runJson || runScannerJson;
  const clock = deps.now || (() => new Date());
  const now = clock();
  const common = ['--home', home, '--client', selected.join(','), '--no-spinner'];
  const report = ['--json', '--group-by', 'client,session,model'];
  const runOptions = { env, signal };
  try {
    const periods = {};
    for (const [period, flags] of [['today', ['--today']], ['month', ['--month']], ['allTime', ['--since', '2024-01-01']]]) {
      if (signal?.aborted) throw scanError('ssh-cancelled');
      const result = await run(binary, [...common, ...report, ...flags], runOptions);
      if (!result || !Array.isArray(result.entries)) throw scanError();
      periods[period] = extractUsageFromTokscale(result);
    }
    if (signal?.aborted) throw scanError('ssh-cancelled');
    const graph = await run(binary, ['graph', ...common], runOptions);
    if (!graph || !Array.isArray(graph.contributions) || localDayKey(clock()) !== localDayKey(now)) throw scanError();
    const history = normalizeHistory(parseGraphResult(graph), { capDays: 366, todayKey: localDayKey(now) });
    return { deviceId: connection.id, hostname: connection.alias || connection.host || connection.label || connection.id,
      platform: remotePlatform, updatedAt: now.toISOString(), agentRuntime: 'ssh-local-scanner', agentVersion: appVersion(),
      trackedClients: selected, ...periods, historyAvailable: true, history, periodWindows: computePeriodWindows(now) };
  } catch (error) {
    if (signal?.aborted || error.code === 'ssh-cancelled') throw scanError('ssh-cancelled');
    if (error.code === 'termination-unconfirmed') throw error;
    throw scanError();
  }
}

module.exports = { collectSshMirror, runScannerJson, scanEnvironment };
