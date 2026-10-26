'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../../src/electron/renderer/sshSyncForm');
const i18n = require('../../src/electron/renderer/i18n');

function fixture({ platform = '', locale = '' } = {}) {
  const nodes = new Map();
  function node(id = '') {
    const listeners = {};
    return { id, value: '', checked: false, hidden: false, disabled: false, children: [],
      classList: { toggle() {} }, setAttribute() {}, focus() {},
      addEventListener(name, fn) { listeners[name] = fn; },
      async dispatch(name, event = {}) { return listeners[name]?.({ preventDefault() {}, ...event }); },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; } };
  }
  const document = { getElementById(id) { if (!nodes.has(id)) nodes.set(id, node(id)); return nodes.get(id); }, createElement: () => node() };
  let settings = { hubMode: 'ssh', sshConnections: [], sshPollIntervalMs: 300000 };
  const calls = { saves: [], tests: [], removes: [], settings: [] };
  const bridge = {
    getStatus: async () => ({ hosts: [] }),
    saveConnection: async value => { calls.saves.push(value); return { settings, status: { hosts: [] } }; },
    testConnection: async value => { calls.tests.push(value); return { ok: true, deviceId: 'remote' }; },
    removeConnection: async id => { calls.removes.push(id); return { settings, status: { hosts: [] } }; },
    refresh: async () => ({ hosts: [] })
  };
  const form = api.createSshSyncForm({ document, bridge,
    t: (key, params) => locale ? i18n.translate(locale, key, params) : key, getSettings: () => settings,
    getPlatform: () => platform,
    onSettings: value => { settings = value; },
    saveSettings: async patch => { calls.settings.push(patch); settings = { ...settings, ...patch }; } });
  const get = name => document.getElementById(`sshSync${name}`);
  return { form, get, calls, bridge, settings(next) { settings = { ...settings, ...next }; form.syncSettings(); } };
}

test('polling interval accepts whole seconds between 15 seconds and 24 hours', () => {
  assert.equal(api.pollIntervalMs('45'), 45000);
  for (const value of ['', '14', '86401', '15.1', 'abc']) assert.throws(() => api.pollIntervalMs(value));
});

test('unrelated settings and status pushes preserve an unsaved host and password', async () => {
  const f = fixture();
  await f.get('Add').dispatch('click');
  f.get('Host').value = 'new.example';
  f.get('Password').value = 'draft secret';
  f.settings({ sshPollIntervalMs: 60000 });
  f.form.applyStatus({ running: true, hosts: [] });
  assert.equal(f.get('Host').value, 'new.example');
  assert.equal(f.get('Password').value, 'draft secret');
});

test('saving a configured password host leaves the saved password alone when blank', async () => {
  const f = fixture();
  f.settings({ sshConnections: [{ id: 'one', label: 'Server', authMode: 'password', host: 'remote', username: 'alice', port: 22, remoteHome: '~', passwordConfigured: true }] });
  await f.get('List').children[0].children[1].children[0].dispatch('click');
  await f.get('Save').dispatch('click');
  assert.equal(f.calls.saves.length, 1);
  assert.equal(Object.hasOwn(f.calls.saves[0], 'password'), false);
  assert.equal(Object.hasOwn(f.calls.saves[0].connection, 'password'), false);
});

test('testing sends a draft password only to the dedicated SSH API and keeps the draft open', async () => {
  const f = fixture();
  await f.get('Add').dispatch('click');
  f.get('AuthMode').value = 'password';
  f.get('Host').value = 'remote';
  f.get('Username').value = 'alice';
  f.get('Password').value = 'draft secret';
  await f.get('Test').dispatch('click');
  assert.equal(f.calls.tests[0].password, 'draft secret');
  assert.equal(f.get('Editor').hidden, false);
  assert.deepEqual(f.calls.settings, []);
});

test('the interval is saved separately without leaking an in-progress connection password', async () => {
  const f = fixture();
  await f.get('Add').dispatch('click');
  f.get('Password').value = 'draft secret';
  f.get('Interval').value = '45';
  await f.get('SaveInterval').dispatch('click');
  assert.deepEqual(f.calls.settings, [{ sshPollIntervalMs: 45000 }]);
  assert.equal(f.get('Password').value, 'draft secret');
});

test('a failed connection save preserves the draft and offers another attempt', async () => {
  const f = fixture();
  f.bridge.saveConnection = async () => { throw new Error('Connection refused'); };
  await f.get('Add').dispatch('click');
  f.get('Alias').value = 'devbox';
  await f.get('Save').dispatch('click');
  assert.equal(f.get('Editor').hidden, false);
  assert.equal(f.get('Alias').value, 'devbox');
  assert.equal(f.get('Save').disabled, false);
  assert.match(f.get('Message').textContent, /Connection refused/);
});

test('removing a host requires the inline confirmation and can be cancelled', async () => {
  const f = fixture();
  f.settings({ sshConnections: [{ id: 'one', authMode: 'alias', alias: 'devbox' }] });
  await f.get('List').children[0].children[1].children[1].dispatch('click');
  assert.deepEqual(f.calls.removes, []);
  assert.equal(f.get('RemoveDecision').hidden, false);
  await f.get('RemoveCancel').dispatch('click');
  assert.equal(f.get('RemoveDecision').hidden, true);
  assert.deepEqual(f.calls.removes, []);
});

test('new password input cancels a pending saved-password removal', async () => {
  const f = fixture();
  await f.get('Add').dispatch('click');
  f.get('Password').value = 'old draft';
  f.get('ClearPassword').checked = true;
  await f.get('ClearPassword').dispatch('change');
  assert.equal(f.get('Password').value, '');
  f.get('Password').value = 'replacement';
  await f.get('Password').dispatch('input');
  assert.equal(f.get('ClearPassword').checked, false);
});

test('Windows explains password support and keeps unsupported connection actions disabled', async () => {
  const f = fixture({ platform: 'win32' });
  await f.get('Add').dispatch('click');
  assert.equal(f.get('PasswordOption').disabled, true);
  assert.equal(f.get('PasswordUnsupported').hidden, false);
  f.get('AuthMode').value = 'password';
  await f.get('AuthMode').dispatch('change');
  assert.equal(f.get('Save').disabled, true);
  assert.equal(f.get('Test').disabled, true);
});

test('editing the interval survives settings pushes and invalid values show actionable feedback', async () => {
  const f = fixture();
  f.get('Interval').value = '7';
  await f.get('Interval').dispatch('input');
  f.settings({ sshPollIntervalMs: 60000 });
  assert.equal(f.get('Interval').value, '7');
  await f.get('SaveInterval').dispatch('click');
  assert.match(f.get('Message').textContent, /invalidInterval/);
  assert.deepEqual(f.calls.settings, []);
});

test('successful save and cancellation clear a draft password', async () => {
  const f = fixture();
  await f.get('Add').dispatch('click');
  f.get('Alias').value = 'devbox';
  f.get('Password').value = 'draft';
  await f.get('Save').dispatch('click');
  assert.equal(f.get('Password').value, '');
  assert.equal(f.get('Editor').hidden, true);
  await f.get('Add').dispatch('click');
  f.get('Password').value = 'another draft';
  await f.get('Cancel').dispatch('click');
  assert.equal(f.get('Password').value, '');
});

test('an active polling service stays manually refreshable while it waits for the next collection', () => {
  const f = fixture();
  f.settings({ sshConnections: [{ id: 'one', authMode: 'alias', alias: 'devbox' }] });
  f.form.applyStatus({ running: true, hosts: [{ id: 'one', running: false }] });
  assert.equal(f.get('Refresh').disabled, false);
  f.form.applyStatus({ running: true, hosts: [{ id: 'one', running: true }] });
  assert.equal(f.get('Refresh').disabled, true);
});

test('polling errors resolve to localized recovery messages instead of raw SSH codes', () => {
  const f = fixture();
  f.settings({ sshConnections: [{ id: 'one', authMode: 'alias', alias: 'devbox' }] });
  f.form.applyStatus({ error: 'ssh-remote-tools-missing', hosts: [{ id: 'one', error: 'ssh-host-key' }] });
  assert.equal(f.get('Message').textContent, 'settings.sync.ssh.error.ssh-remote-tools-missing');
  assert.match(f.get('List').children[0].children[0].children[1].textContent, /settings.sync.ssh.error.ssh-host-key/);
});

for (const code of ['ssh-remote-home-missing', 'ssh-remote-tools-missing', 'ssh-read-failed',
  'ssh-transfer-limit', 'ssh-expanded-limit', 'ssh-file-limit', 'ssh-unsafe-archive',
  'ssh-no-session-data', 'ssh-local-scan-failed', 'ssh-local-storage-failed', 'ssh-test-busy']) {
  test(`structured ${code} test failures show localized recovery and preserve the connection draft`, async () => {
    const f = fixture({ locale: 'zh-CN' });
    f.bridge.testConnection = async () => ({ ok: false, errorCode: code,
      error: 'Error invoking remote method: English diagnostic with sensitive detail' });
    await f.get('Add').dispatch('click');
    f.get('Alias').value = 'devbox';
    f.get('Password').value = 'retained draft';
    await f.get('Test').dispatch('click');
    const message = f.get('Message').textContent;
    assert.equal(message, i18n.translate('zh-CN', `settings.sync.ssh.error.${code}`));
    assert.doesNotMatch(message, /settings\.sync/);
    assert.doesNotMatch(message, /Error invoking|English diagnostic|sensitive detail/);
    assert.equal(f.get('Editor').hidden, false);
    assert.equal(f.get('Alias').value, 'devbox');
    assert.equal(f.get('Password').value, 'retained draft');
    assert.equal(f.get('Test').disabled, false);
  });
}

test('legacy test rejection extracts only a recognized stable error code from the IPC wrapper', async () => {
  const f = fixture({ locale: 'zh-CN' });
  f.bridge.testConnection = async () => {
    throw new Error('Error invoking remote method sshSync:testConnection: ssh-auth-failed: hidden diagnostics');
  };
  await f.get('Add').dispatch('click');
  f.get('Alias').value = 'devbox';
  await f.get('Test').dispatch('click');
  assert.equal(f.get('Message').textContent, i18n.translate('zh-CN', 'settings.sync.ssh.error.ssh-auth-failed'));
});

for (const rejected of [false, true]) test(`unrecognized ${rejected ? 'rejected' : 'structured'} test errors use generic localized feedback`, async () => {
  const f = fixture({ locale: 'zh-CN' });
  f.bridge.testConnection = async () => {
    if (rejected) throw new Error('Error invoking remote method sshSync:testConnection: Check the remote Token Monitor path, Node.js and installed project dependencies.');
    return { ok: false, errorCode: 'ssh-not-a-known-code', error: 'private remote diagnostics' };
  };
  await f.get('Add').dispatch('click');
  f.get('Alias').value = 'devbox';
  await f.get('Test').dispatch('click');
  assert.equal(f.get('Message').textContent, i18n.translate('zh-CN', 'settings.sync.ssh.failed'));
  assert.equal(f.get('Alias').value, 'devbox');
});

test('remote home is optional and the submitted connection never contains a remote project path', async () => {
  const f = fixture();
  await f.get('Add').dispatch('click');
  f.get('Alias').value = 'devbox';
  f.get('RemoteHome').value = '';
  await f.get('Save').dispatch('click');
  assert.equal(f.calls.saves[0].connection.remoteHome, '~');
  assert.equal(Object.hasOwn(f.calls.saves[0].connection, 'remotePath'), false);
});

test('a saved remote home survives editing while an old project path does not become a home directory', async () => {
  const f = fixture();
  f.settings({ sshConnections: [{ id: 'old', authMode: 'alias', alias: 'devbox', remotePath: '~/token-monitor' }] });
  await f.get('List').children[0].children[1].children[0].dispatch('click');
  assert.equal(f.get('RemoteHome').value, '~');
  await f.get('Cancel').dispatch('click');
  f.settings({ sshConnections: [{ id: 'new', authMode: 'alias', alias: 'devbox', remoteHome: '/home/alice' }] });
  await f.get('List').children[0].children[1].children[0].dispatch('click');
  assert.equal(f.get('RemoteHome').value, '/home/alice');
  await f.get('Save').dispatch('click');
  assert.equal(f.calls.saves[0].connection.remoteHome, '/home/alice');
});

test('SSH help describes file-based collection without remote application prerequisites', () => {
  for (const locale of Object.keys(i18n.MESSAGES)) {
    const keys = Object.keys(i18n.MESSAGES[locale]).filter(key => key.startsWith('settings.sync.ssh.'));
    const copy = keys.map(key => i18n.translate(locale, key)).join('\n');
    assert.doesNotMatch(copy, /Node\.js|npm |tokscale|checkout|Token Monitor.*(?:directory|项目|專案|ディレクトリ|디렉터리|diretório)/i);
    assert.ok(i18n.MESSAGES[locale]['settings.sync.ssh.remoteHome']);
    assert.equal(i18n.MESSAGES[locale]['settings.sync.ssh.remotePath'], undefined);
  }
  assert.match(i18n.translate('en', 'settings.sync.ssh.note'), /file-based sessions.*Claude Code.*Codex.*Kimi/);
  assert.match(i18n.translate('zh-CN', 'settings.sync.ssh.setupNote'), /HOME.*sh.*find.*tar/);
});
