'use strict';

const { randomUUID } = require('node:crypto');

function validId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)
    || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error('Invalid SSH connection id');
  return value;
}

function sameEndpoint(a, b) {
  return Boolean(a && b) && ['authMode', 'host', 'port', 'username'].every((key) => a[key] === b[key]);
}

// Metadata follows settings.json; passwords use dynamic entries in the one
// canonical credential store. No read API returns a credential to the renderer.
function createSshSyncSettings({ getSettings, store, commitConnections, normalize, collect }) {
  let testController = null;
  function saved() { return getSettings().sshConnections || []; }
  function password(id) {
    validId(id);
    const record = store.readDocument().credentials.ssh?.[id];
    return typeof record?.password === 'string' ? record.password : '';
  }
  function connections() {
    return saved().map((connection) => ({ ...normalize(connection), passwordConfigured: Boolean(password(connection.id)) }));
  }
  function draft(options = {}, allowClear = false) {
    const raw = options.connection;
    if (!raw || typeof raw !== 'object') throw new Error('Invalid SSH connection');
    const id = validId(raw.id || randomUUID());
    const connection = normalize({ ...raw, id });
    const existing = saved().find((row) => row.id === id);
    if (options.password !== undefined && (typeof options.password !== 'string' || options.password.length > 16384 || /[\0\r\n]/.test(options.password))) {
      throw new Error('Invalid SSH password');
    }
    const nextPassword = options.clearPassword === true ? ''
      : options.password || (sameEndpoint(existing, connection) ? password(id) : '');
    if (connection.authMode === 'password' && !nextPassword && !(allowClear && options.clearPassword === true)) throw new Error('SSH password is required for this host and username');
    return { connection, password: connection.authMode === 'password' ? nextPassword : '' };
  }
  function commit(list, changeCredentials) {
    const previous = store.readDocument();
    const next = structuredClone(previous);
    next.credentials.ssh ||= {};
    changeCredentials(next.credentials.ssh);
    let credentialsCommitted = false;
    try {
      try { store.writeDocument(next); credentialsCommitted = true; }
      catch (error) { credentialsCommitted = error.atomicWriteCommitted === true; throw error; }
      commitConnections(list);
    } catch (error) {
      if (credentialsCommitted) store.writeDocument(previous);
      throw error;
    }
  }
  function save(options) {
    const next = draft(options, true);
    const list = saved().filter((row) => row.id !== next.connection.id);
    if (list.length >= 20) throw new Error('At most 20 SSH connections are supported');
    const duplicate = list.some((row) => row.authMode === next.connection.authMode
      && row.remotePath === next.connection.remotePath
      && (row.authMode === 'alias' ? row.alias === next.connection.alias : sameEndpoint(row, next.connection)));
    if (duplicate) throw new Error('This SSH target is already configured');
    list.push(next.connection);
    commit(list, (credentials) => {
      if (next.password) credentials[next.connection.id] = { password: next.password };
      else delete credentials[next.connection.id];
    });
    return next.connection;
  }
  function remove(id) {
    validId(id);
    commit(saved().filter((row) => row.id !== id), (credentials) => { delete credentials[id]; });
  }
  async function test(options) {
    if (testController) throw new Error('An SSH connection test is already running');
    const next = draft(options);
    testController = new AbortController();
    try {
      const result = await collect(next.connection, { password: next.password, timeoutMs: 180000, signal: testController.signal });
      return { ok: true, deviceId: String(result.deviceId || '') };
    } finally { testController = null; }
  }
  return { connections, password, save, remove, test, cancelTest: () => testController?.abort() };
}

module.exports = { createSshSyncSettings };
