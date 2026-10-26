'use strict';

(function exposeSshSyncForm(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorSshSyncForm = api;
})(typeof window !== 'undefined' ? window : null, function createSshSyncFormApi() {
  const ERROR_CODES = new Set(['ssh-cancelled', 'ssh-unavailable', 'ssh-auth-failed', 'ssh-host-key',
    'ssh-agent-unavailable', 'ssh-timeout', 'ssh-output-limit', 'ssh-invalid-output',
    'ssh-password-invalid', 'ssh-password-unsupported', 'ssh-invalid-connection', 'ssh-failed']);
  function pollIntervalMs(value) {
    const seconds = Number(value);
    if (!String(value).trim() || !Number.isInteger(seconds) || seconds < 15 || seconds > 86400) {
      throw new Error('invalidInterval');
    }
    return seconds * 1000;
  }

  function createSshSyncForm({ document, bridge = {}, t, getSettings, saveSettings, onSettings, getPlatform = () => '' }) {
    const el = suffix => document.getElementById(`sshSync${suffix}`);
    const text = (key, params) => t(`settings.sync.ssh.${key}`, params);
    const inputNames = ['Label', 'AuthMode', 'Alias', 'Host', 'Port', 'Username', 'Password', 'ClearPassword', 'RemotePath'];
    let settings = getSettings() || {};
    let status = settings.sshSyncStatus || {};
    let draft = null;
    let busy = false;
    let intervalDirty = false;
    let removing = null;
    let disposed = false;
    let message = '';
    let messageIsError = false;
    const listeners = [];

    function listen(suffix, event, fn) {
      const node = el(suffix);
      node.addEventListener(event, fn);
      listeners.push(() => node.removeEventListener?.(event, fn));
    }
    function note(value, error = false) {
      message = value;
      messageIsError = error;
      renderStatus();
    }
    function errorMessage(value) {
      const code = typeof value === 'string' ? value : value?.code;
      return ERROR_CODES.has(code) ? text(`error.${code}`) : String(value?.message || value || '').slice(0, 500);
    }
    function timestamp(value) {
      const date = new Date(value);
      return Number.isFinite(date.getTime()) ? date.toLocaleString() : text('notCollected');
    }
    function renderStatus() {
      const collecting = status.hosts?.some(host => host.running === true) === true;
      const summary = collecting ? text('collecting') : status.lastSuccessAt
        ? text('lastSuccess', { time: timestamp(status.lastSuccessAt) }) : text('notCollected');
      el('Status').textContent = summary;
      el('Message').textContent = message || errorMessage(status.error);
      el('Message').hidden = !el('Message').textContent;
      el('Message').classList.toggle('error', messageIsError || Boolean(status.error));
      el('Refresh').disabled = busy || collecting || !settings.sshConnections?.length;
      el('Refresh').textContent = text(collecting ? 'collecting' : 'refresh');
    }
    function authFields() {
      const password = el('AuthMode').value === 'password';
      el('AliasFields').hidden = password;
      el('PasswordFields').hidden = !password;
      el('AliasFields').inert = password;
      el('PasswordFields').inert = !password;
      el('Password').placeholder = text(draft?.passwordConfigured ? 'passwordSaved' : 'passwordPlaceholder');
      el('ClearPasswordRow').hidden = !draft?.passwordConfigured;
      el('PasswordUnsupported').hidden = getPlatform() !== 'win32';
      el('PasswordOption').disabled = getPlatform() === 'win32';
      for (const name of ['Save', 'Test']) el(name).disabled = busy || (password && getPlatform() === 'win32');
    }
    function renderConnections() {
      const nodes = (settings.sshConnections || []).map(connection => {
        const row = document.createElement('div');
        row.className = 'ssh-sync-host';
        row.setAttribute('role', 'listitem');
        const content = document.createElement('div');
        content.className = 'ssh-sync-host-content';
        const title = document.createElement('strong');
        title.textContent = connection.label || connection.alias || connection.host;
        const detail = document.createElement('span');
        const hostStatus = status.hosts?.find(item => item.id === connection.id || item.connectionId === connection.id);
        const destination = connection.authMode === 'password'
          ? `${connection.username || ''}@${connection.host || ''}:${connection.port || 22}` : connection.alias;
        detail.textContent = `${destination} · ${errorMessage(hostStatus?.error) || (hostStatus?.running ? text('collecting')
          : hostStatus?.lastSuccessAt ? timestamp(hostStatus.lastSuccessAt) : text('notCollected'))}`;
        content.append(title, detail);
        const actions = document.createElement('div');
        actions.className = 'ssh-sync-host-actions';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.textContent = text('edit');
        edit.disabled = busy || Boolean(draft);
        edit.addEventListener('click', () => openEditor(connection));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = text('remove');
        remove.disabled = busy;
        remove.addEventListener('click', () => {
          removing = connection;
          el('RemoveCopy').textContent = text('removeConfirm', { name: title.textContent });
          el('RemoveDecision').hidden = false;
          el('RemoveCancel').focus();
        });
        actions.append(edit, remove);
        row.append(content, actions);
        return row;
      });
      el('List').replaceChildren(...nodes);
      el('Empty').hidden = nodes.length > 0;
      el('Add').disabled = busy || Boolean(draft);
    }
    function renderBusy() {
      for (const name of [...inputNames, 'Test', 'Save', 'Cancel', 'Interval', 'SaveInterval', 'RemoveConfirm', 'RemoveCancel']) {
        el(name).disabled = busy;
      }
      authFields();
      renderConnections();
      renderStatus();
    }
    function openEditor(connection = {}) {
      draft = { ...connection };
      removing = null;
      el('RemoveDecision').hidden = true;
      const defaults = { Label: '', AuthMode: 'alias', Alias: '', Host: '', Port: 22, Username: '', RemotePath: '~/token-monitor' };
      for (const [field, fallback] of Object.entries(defaults)) {
        const key = field[0].toLowerCase() + field.slice(1);
        el(field).value = connection[key] ?? fallback;
      }
      el('Password').value = '';
      el('ClearPassword').checked = false;
      el('Editor').hidden = false;
      authFields();
      note('');
      renderConnections();
      el('Label').focus();
    }
    function closeEditor() {
      draft = null;
      el('Password').value = '';
      el('ClearPassword').checked = false;
      el('Editor').hidden = true;
      renderConnections();
      el('Add').focus();
    }
    function request() {
      const connection = { id: draft?.id || '', label: el('Label').value.trim(), authMode: el('AuthMode').value,
        alias: el('Alias').value.trim(), host: el('Host').value.trim(), port: Number(el('Port').value),
        username: el('Username').value.trim(), remotePath: el('RemotePath').value.trim() };
      if (!connection.remotePath || (connection.authMode === 'alias' ? !connection.alias
        : !connection.host || !connection.username || !Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535)) {
        throw new Error(text('required'));
      }
      const value = { connection };
      if (connection.authMode === 'password' && el('Password').value) value.password = el('Password').value;
      if (el('ClearPassword').checked) value.clearPassword = true;
      return value;
    }
    function accept(result) {
      if (result?.settings) { onSettings?.(result.settings); settings = result.settings; }
      if (result?.status) status = result.status;
    }
    async function run(action) {
      if (busy || disposed) return;
      busy = true;
      note('');
      renderBusy();
      try { await action(); } catch (error) {
        if (!disposed) note(errorMessage(error) || text('failed'), true);
      } finally {
        busy = false;
        if (!disposed) renderBusy();
      }
    }
    listen('Add', 'click', () => openEditor());
    listen('Cancel', 'click', closeEditor);
    listen('AuthMode', 'change', authFields);
    listen('Password', 'input', () => { el('ClearPassword').checked = false; });
    listen('ClearPassword', 'change', () => { if (el('ClearPassword').checked) el('Password').value = ''; });
    listen('Interval', 'input', () => { intervalDirty = true; });
    listen('SaveInterval', 'click', () => run(async () => {
      let interval;
      try { interval = pollIntervalMs(el('Interval').value); } catch (cause) { throw new Error(text('invalidInterval'), { cause }); }
      await saveSettings({ sshPollIntervalMs: interval });
      intervalDirty = false;
      note(text('saved'));
    }));
    listen('Save', 'click', () => run(async () => {
      const result = await bridge.saveConnection(request());
      if (disposed) return;
      accept(result);
      closeEditor();
      note(text('saved'));
    }));
    listen('Test', 'click', () => run(async () => {
      note(text('testing'));
      const result = await bridge.testConnection(request());
      if (disposed) return;
      if (!result?.ok) throw new Error(result?.error || text('failed'));
      note(text('testSuccess', { device: result.deviceId || '' }));
    }));
    listen('Refresh', 'click', () => run(async () => {
      status = await bridge.refresh();
      if (!disposed) renderStatus();
    }));
    listen('RemoveCancel', 'click', () => { removing = null; el('RemoveDecision').hidden = true; });
    listen('RemoveConfirm', 'click', () => run(async () => {
      if (!removing) return;
      const id = removing.id;
      const result = await bridge.removeConnection(id);
      if (disposed) return;
      accept(result);
      if (draft?.id === id) closeEditor();
      removing = null;
      el('RemoveDecision').hidden = true;
      note(text('removed'));
    }));

    function syncSettings() {
      settings = getSettings() || {};
      if (settings.sshSyncStatus) status = settings.sshSyncStatus;
      const visible = settings.hubMode === 'ssh';
      el('Fields').hidden = !visible;
      el('Fields').inert = !visible;
      if (!intervalDirty) el('Interval').value = String((settings.sshPollIntervalMs || 300000) / 1000);
      authFields();
      renderBusy();
    }
    syncSettings();
    el('Editor').hidden = true;
    el('RemoveDecision').hidden = true;
    return {
      syncSettings,
      applyStatus(next) { if (next && !disposed) { status = next; renderConnections(); renderStatus(); } },
      async refreshStatus() {
        if (!bridge.getStatus || disposed) return;
        try { const next = await bridge.getStatus(); if (!disposed) { status = next; renderConnections(); renderStatus(); } }
      catch (error) { if (!disposed) note(errorMessage(error) || text('failed'), true); }
      },
      dispose() { disposed = true; el('Password').value = ''; for (const remove of listeners) remove(); }
    };
  }
  return { createSshSyncForm, pollIntervalMs };
});
