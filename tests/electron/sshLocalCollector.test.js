'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collectSshMirror, scanEnvironment } = require('../../src/electron/sshLocalCollector');

test('remote mirrors are scanned locally with explicit home, a fixed client filter and no inherited source overrides', async () => {
  const calls = [];
  let active = false;
  const result = await collectSshMirror({ home: '/private/mirror', connection: { id: 'dev', alias: 'dev' }, clients: ['codex', 'kimi'] }, {
    resolveBinary: () => '/local/tokscale',
    now: () => new Date('2026-10-26T00:00:00Z'),
    runJson: async (binary, args, options) => {
      assert.equal(active, false); active = true;
      calls.push({ binary, args, env: options.env });
      await Promise.resolve(); active = false;
      if (args.includes('graph')) return { contributions: [] };
      return { entries: [{ client: 'codex', model: 'gpt-5.4', sessionId: 'remote-session', inputTokens: 100, outputTokens: 10, totalTokens: 110, cost: 0.1 }] };
    }
  });
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.binary, '/local/tokscale');
    assert.equal(call.args[call.args.indexOf('--home') + 1], '/private/mirror');
    assert.equal(call.args[call.args.indexOf('--client') + 1], 'codex,kimi');
    assert.equal(call.env.HOME, '/private/mirror');
    assert.equal(Object.hasOwn(call.env, 'TOKSCALE_EXTRA_DIRS'), false);
  }
  assert.equal(result.today.totalTokens, 110);
  assert.equal(result.allTime.totalTokens, 110);
  assert.equal(result.agentRuntime, 'ssh-local-scanner');
});

test('an empty supported-source set never expands into all local clients', async () => {
  let scans = 0;
  await assert.rejects(collectSshMirror({ home: '/private/mirror', connection: { id: 'dev' }, clients: ['opencode'] }, {
    runJson: () => { scans += 1; }, resolveBinary: () => '/scanner'
  }), error => error.code === 'ssh-no-session-data');
  assert.equal(scans, 0);
});

test('the mirror environment excludes local provider credentials and absolute scanner overrides', () => {
  const env = scanEnvironment('/mirror', { PATH: '/bin', CODEX_HOME: '/real/codex', TOKSCALE_EXTRA_DIRS: 'codex:/real', TOKEN: 'secret', XDG_DATA_HOME: '/real/data' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.CODEX_HOME, '/mirror/.codex');
  assert.equal(env.XDG_DATA_HOME, '/mirror/.local/share');
  assert.equal(Object.hasOwn(env, 'TOKEN'), false);
  assert.equal(Object.hasOwn(env, 'TOKSCALE_EXTRA_DIRS'), false);
});

test('local parse failures do not expose subprocess diagnostics', async () => {
  await assert.rejects(collectSshMirror({ home: '/mirror', connection: { id: 'dev' }, clients: ['codex'] }, {
    resolveBinary: () => '/scanner', runJson: async () => { throw new Error('sensitive diagnostic'); }
  }), error => error.code === 'ssh-local-scan-failed' && !error.message.includes('sensitive'));
});

test('valid JSON with the wrong report shape cannot replace a previous observation with zero', async () => {
  await assert.rejects(collectSshMirror({ home: '/mirror', connection: { id: 'dev' }, clients: ['codex'] }, {
    resolveBinary: () => '/scanner', runJson: async () => ({})
  }), error => error.code === 'ssh-local-scan-failed');
});

test('a scan crossing the local day boundary is rejected instead of publishing mismatched period windows', async () => {
  const times = [new Date('2026-10-26T23:59:59+08:00'), new Date('2026-10-27T00:00:01+08:00')];
  await assert.rejects(collectSshMirror({ home: '/mirror', connection: { id: 'dev' }, clients: ['codex'] }, {
    resolveBinary: () => '/scanner', now: () => times.shift(),
    runJson: async (_binary, args) => args.includes('graph') ? { contributions: [] } : { entries: [] }
  }), error => error.code === 'ssh-local-scan-failed');
});
