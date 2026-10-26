'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSshSyncSettings } = require('../../src/electron/sshSyncSettings');

function fixture() {
  let settings = { sshConnections: [] };
  let document = { version: 1, credentials: {}, migrations: {} };
  let fail = false;
  const service = createSshSyncSettings({
    getSettings: () => settings,
    store: { readDocument: () => structuredClone(document), writeDocument: (value) => { document = structuredClone(value); } },
    commitConnections: (value) => { if (fail) throw new Error('disk full'); settings = { ...settings, sshConnections: value }; },
    normalize: (value) => ({ id: value.id, label: value.label || '', authMode: value.authMode || 'password', host: value.host, port: value.port || 22, username: value.username || 'user', remotePath: value.remotePath || '~/token-monitor' }),
    collect: async (connection, options) => ({ deviceId: connection.host, passwordUsed: options.password })
  });
  return { service, settings: () => settings, document: () => document, fail: () => { fail = true; } };
}

test('passwords live only in the credential store and a blank edit preserves them', () => {
  const f = fixture();
  f.service.save({ connection: { id: 'dev', host: 'host' }, password: 'private-value' });
  assert.equal(f.service.password('dev'), 'private-value');
  assert.equal(JSON.stringify(f.settings()).includes('private-value'), false);
  assert.equal(JSON.stringify(f.service.connections()).includes('private-value'), false);
  assert.equal(f.service.connections()[0].passwordConfigured, true);
  f.service.save({ connection: { id: 'dev', host: 'host', label: 'new label' }, password: '' });
  assert.equal(f.service.password('dev'), 'private-value');
});

test('a changed SSH endpoint requires a new password instead of sending a saved secret elsewhere', () => {
  const f = fixture();
  f.service.save({ connection: { id: 'dev', host: 'trusted' }, password: 'private-value' });
  assert.throws(() => f.service.save({ connection: { id: 'dev', host: 'other' } }), /password/i);
  assert.equal(f.settings().sshConnections[0].host, 'trusted');
});

test('adding the same remote target twice is rejected to prevent duplicate usage', () => {
  const f = fixture();
  f.service.save({ connection: { id: 'first', host: 'host' }, password: 'a' });
  assert.throws(() => f.service.save({ connection: { id: 'second', host: 'host' }, password: 'a' }), /already configured/);
  assert.equal(f.service.connections().length, 1);
  assert.equal(f.service.password('second'), '');
});

test('a failed metadata save restores the previous credential document', () => {
  const f = fixture();
  f.service.save({ connection: { id: 'dev', host: 'host' }, password: 'old' });
  f.fail();
  assert.throws(() => f.service.save({ connection: { id: 'dev', host: 'host' }, password: 'new' }), /disk full/);
  assert.equal(f.service.password('dev'), 'old');
});

test('explicitly clearing a saved password removes the secret and leaves the host awaiting configuration', async () => {
  const f = fixture();
  f.service.save({ connection: { id: 'dev', host: 'host' }, password: 'private-value' });
  f.service.save({ connection: { id: 'dev', host: 'host' }, clearPassword: true });
  assert.equal(f.service.password('dev'), '');
  assert.equal(f.service.connections()[0].passwordConfigured, false);
  await assert.rejects(f.service.test({ connection: { id: 'dev', host: 'host' } }), /password/i);
  for (const password of ['line\nline', 'line\rline', '\0']) {
    assert.throws(() => f.service.save({ connection: { id: 'dev', host: 'host' }, password }), /password/i);
  }
});

test('connection removal clears its password but leaves unrelated credentials', () => {
  const f = fixture();
  f.service.save({ connection: { id: 'dev', host: 'host' }, password: 'a' });
  f.service.save({ connection: { id: 'other', host: 'other' }, password: 'b' });
  f.service.remove('dev');
  assert.equal(f.service.password('dev'), '');
  assert.equal(f.service.password('other'), 'b');
  assert.equal(f.service.connections().length, 1);
  assert.throws(() => f.service.remove('__proto__'), /id/i);
});

test('testing an edited endpoint never borrows its saved password', async () => {
  const f = fixture();
  f.service.save({ connection: { id: 'dev', host: 'trusted' }, password: 'private-value' });
  await assert.rejects(f.service.test({ connection: { id: 'dev', host: 'other' } }), /password/i);
  assert.deepEqual(await f.service.test({ connection: { id: 'dev', host: 'trusted' } }), { ok: true, deviceId: 'trusted' });
});
