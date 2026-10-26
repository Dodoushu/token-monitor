'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { finished } = require('node:stream/promises');
const { gzipSync } = require('node:zlib');
const test = require('node:test');
const { buildRemoteArchiveCommand, createSshMirror, isAllowedSessionPath } = require('../../src/electron/sshMirror');

function tarEntry(name, text = 'data', type = '0', options = {}) {
  const bytes = Buffer.from(text);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write('0000600\0', 100, 8);
  header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 12);
  header.fill(32, 148, 156);
  header.write(type, 156, 1);
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);
  if (options.linkname) header.write(options.linkname, 157, 100);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

function archive(entries, compressed = false) {
  const tar = Buffer.concat([...entries, Buffer.alloc(1024)]);
  return Buffer.concat([Buffer.from('TMSSH1 Linux\n'), compressed ? gzipSync(tar) : tar]);
}

async function receive(bytes, options) {
  const mirror = createSshMirror(options);
  const done = finished(mirror.stream);
  // Exercise headers, gzip magic, file data and block padding split at arbitrary boundaries.
  for (let offset = 0; offset < bytes.length && !mirror.stream.destroyed; offset += 73) mirror.stream.write(bytes.subarray(offset, offset + 73));
  mirror.stream.end();
  try { await done; return mirror; }
  catch (error) { mirror.cleanup(); throw error; }
}

test('SSH mirror allowlist includes file-backed sessions and excludes credentials/databases', () => {
  for (const file of ['.codex/sessions/2026/rollout.jsonl', '.codex/archived_sessions/old.jsonl.zst',
    '.claude/projects/project/subagents/agent.jsonl', '.claude/transcripts/a.jsonl',
    '.kimi/sessions/group/session/wire.jsonl', '.kimi-code/sessions/project/session/agents/main/wire.jsonl',
    '.factory/sessions/p/s.settings.json', '.qwen/projects/p/a.jsonl', '.gemini/tmp/p/chats/session-a.json',
    '.openclaw/agents/main/sessions/a.jsonl', '.pi/agent/sessions/p/a.jsonl', '.grok/sessions/p/id/summary.json',
    '.grok/logs/unified.jsonl', '.commandcode/projects/p/a.jsonl', '.codebuddy/projects/p/a.jsonl',
    '.dsh/sessions/p/id/session.v3.jsonl.zstd']) assert.ok(isAllowedSessionPath(file), file);
  for (const file of ['.codex/auth.json', '.claude/settings.json', '.ssh/id_ed25519', '.kimi-code/config.toml',
    '.kimi-code/sessions/p/session/state.json', '.local/share/opencode/opencode.db',
    '.openclaw/agents/main/auth-profiles.json', '.openclaw/agents/main/sessions/auth.json',
    '../.codex/sessions/a.jsonl', '/.codex/sessions/a.jsonl', '.codex/sessions/../../auth.json',
    '.codex\\sessions\\file.jsonl', 'C:/.codex/sessions/file.jsonl']) assert.equal(isAllowedSessionPath(file), false, file);
});

test('streamed tar and gzip archives create only private regular files and discover clients', async () => {
  for (const compressed of [false, true]) {
    const mirror = await receive(archive([
      tarEntry('./.codex/sessions/a.jsonl', 'codex-data'),
      tarEntry('.kimi-code/sessions/p/s/wire.jsonl', 'kimi-data')
    ], compressed));
    const directory = mirror.home;
    try {
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
        assert.equal(fs.statSync(path.join(directory, '.codex/sessions/a.jsonl')).mode & 0o777, 0o600);
      }
      assert.equal(fs.readFileSync(path.join(directory, '.codex/sessions/a.jsonl'), 'utf8'), 'codex-data');
      assert.equal(mirror.result().files, 2);
      assert.equal(mirror.result().remotePlatform, 'linux');
      assert.deepEqual(mirror.result().clients.sort(), ['codex', 'kimi']);
    } finally { mirror.cleanup(); }
    assert.equal(fs.existsSync(directory), false);
  }
});

test('tar extraction rejects links, traversal, unknown roots, corrupt and duplicate entries', async () => {
  for (const entries of [
    [tarEntry('../../escape.jsonl')], [tarEntry('/.codex/sessions/a.jsonl')],
    [tarEntry('.ssh/id_rsa')], [tarEntry('.codex/sessions/a.jsonl', '', '2', { linkname: '/etc/passwd' })],
    [tarEntry('.codex/sessions/a.jsonl', '', '1', { linkname: '.codex/sessions/b.jsonl' })],
    [tarEntry('.codex/sessions/a.jsonl'), tarEntry('.codex/sessions/a.jsonl')],
    [Buffer.alloc(512, 1)]
  ]) await assert.rejects(receive(archive(entries)), { code: 'ssh-unsafe-archive' });
  await assert.rejects(receive(Buffer.from('not a framed tar archive')), { code: 'ssh-unsafe-archive' });
  await assert.rejects(receive(archive([tarEntry('.codex/sessions/a.jsonl')]).subarray(0, 600)), { code: 'ssh-unsafe-archive' });
});

test('compressed transfer, expanded data and file counts have separate hard bounds', async () => {
  await assert.rejects(receive(archive([tarEntry('.codex/sessions/a.jsonl', 'x'.repeat(1000))]), { maxTransferBytes: 100 }), { code: 'ssh-transfer-limit' });
  await assert.rejects(receive(archive([tarEntry('.codex/sessions/a.jsonl', 'x'.repeat(10000))], true), { maxExpandedBytes: 2000 }), { code: 'ssh-expanded-limit' });
  await assert.rejects(receive(archive([tarEntry('.codex/sessions/a.jsonl'), tarEntry('.codex/sessions/b.jsonl')]), { maxFiles: 1 }), { code: 'ssh-file-limit' });
});

test('short file writes are completed and zero-progress writes fail before a snapshot is accepted', async () => {
  const original = fs.writeSync;
  fs.writeSync = (fd, buffer, offset, length) => original(fd, buffer, offset, Math.min(3, length));
  try {
    const mirror = await receive(archive([tarEntry('.codex/sessions/a.jsonl', 'complete-data-despite-short-writes')]));
    try { assert.equal(fs.readFileSync(path.join(mirror.home, '.codex/sessions/a.jsonl'), 'utf8'), 'complete-data-despite-short-writes'); }
    finally { mirror.cleanup(); }
    fs.writeSync = () => 0;
    await assert.rejects(receive(archive([tarEntry('.codex/sessions/a.jsonl', 'data')])), { code: 'ssh-local-storage-failed' });
  } finally { fs.writeSync = original; }
});

test('PAX and GNU long names stay subject to the same filename allowlist', async () => {
  const name = '.codex/sessions/' + 'a'.repeat(120) + '.jsonl';
  const keyValue = `path=${name}\n`;
  let length = keyValue.length + 3;
  while (String(length).length + keyValue.length + 1 !== length) length = String(length).length + keyValue.length + 1;
  for (const entries of [
    [tarEntry('PaxHeader', `${length} ${keyValue}`, 'x'), tarEntry('placeholder', 'long-name')],
    [tarEntry('././@LongLink', name + '\0', 'L'), tarEntry('placeholder', 'long-name')]
  ]) {
    const mirror = await receive(archive(entries));
    try { assert.equal(fs.readFileSync(path.join(mirror.home, name), 'utf8'), 'long-name'); }
    finally { mirror.cleanup(); }
  }
  await assert.rejects(receive(archive([
    tarEntry('././@LongLink', '../escape\0', 'L'), tarEntry('placeholder')
  ])), { code: 'ssh-unsafe-archive' });
});

test('sequential tar batches are consumed without losing files after end markers', async () => {
  const bytes = Buffer.concat([Buffer.from('TMSSH1 Darwin\n'), tarEntry('.codex/sessions/a.jsonl'), Buffer.alloc(1024),
    tarEntry('.claude/projects/p/b.jsonl'), Buffer.alloc(1024)]);
  const mirror = await receive(bytes);
  try {
    assert.equal(mirror.result().files, 2);
    assert.equal(mirror.result().remotePlatform, 'darwin');
  } finally { mirror.cleanup(); }
});

test('remote shell command archives only whitelisted session files without Node or project dependencies', {
  skip: process.platform === 'win32' ? 'requires local POSIX shell and file tools to emulate the remote host' : false
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-remote-home-'));
  const remoteHome = path.join(root, "home'a;$(touch injected)");
  fs.mkdirSync(path.join(remoteHome, '.codex/sessions'), { recursive: true });
  fs.mkdirSync(path.join(remoteHome, '.kimi-code/sessions/p/s'), { recursive: true });
  fs.writeFileSync(path.join(remoteHome, '.codex/sessions/a.jsonl'), 'codex');
  fs.writeFileSync(path.join(remoteHome, '.codex/auth.json'), 'never transfer');
  fs.writeFileSync(path.join(remoteHome, '.kimi-code/sessions/p/s/wire.jsonl'), 'kimi');
  fs.writeFileSync(path.join(remoteHome, '.kimi-code/sessions/p/s/state.json'), 'never transfer');
  const { execFile } = require('node:child_process');
  try {
    const output = await new Promise((resolve, reject) => execFile('/bin/sh', ['-c', buildRemoteArchiveCommand(remoteHome)], {
      cwd: root, env: { HOME: remoteHome, PATH: '/usr/bin:/bin' }, encoding: 'buffer'
    }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
    assert.match(output.stderr.toString(), /TMSSH_ARCHIVE_OK/);
    const mirror = await receive(output.stdout);
    try {
      assert.equal(mirror.result().files, 2);
      assert.equal(fs.existsSync(path.join(mirror.home, '.codex/auth.json')), false);
      assert.equal(fs.existsSync(path.join(root, 'injected')), false);
    } finally { mirror.cleanup(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('remote source roots refuse symlink ancestors and uncompressed fallback needs no gzip', {
  skip: process.platform === 'win32' ? 'requires local POSIX shell, file tools and symlinks to emulate the remote host' : false
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-remote-links-'));
  const home = path.join(root, 'home');
  const outside = path.join(root, 'outside');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(outside, 'sessions'), { recursive: true });
  fs.mkdirSync(bin);
  for (const [tool, file] of [['sh', '/bin/sh'], ['find', '/usr/bin/find'], ['tar', '/usr/bin/tar'], ['uname', '/usr/bin/uname']]) fs.symlinkSync(file, path.join(bin, tool));
  fs.symlinkSync(outside, path.join(home, '.codex'), 'dir');
  fs.writeFileSync(path.join(outside, 'sessions/not-authorized.jsonl'), 'must-not-transfer');
  fs.mkdirSync(path.join(home, '.kimi/sessions/p/s'), { recursive: true });
  fs.writeFileSync(path.join(home, '.kimi/sessions/p/s/wire.jsonl'), 'allowed-kimi');
  const { execFile } = require('node:child_process');
  try {
    const output = await new Promise((resolve, reject) => execFile('/bin/sh', ['-c', buildRemoteArchiveCommand('~')], {
      env: { HOME: home, PATH: bin }, encoding: 'buffer'
    }, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr })));
    assert.match(output.stderr.toString(), /TMSSH_ARCHIVE_OK/);
    const headerEnd = output.stdout.indexOf(10) + 1;
    assert.notDeepEqual([...output.stdout.subarray(headerEnd, headerEnd + 2)], [0x1f, 0x8b]);
    const mirror = await receive(output.stdout);
    try {
      assert.deepEqual(mirror.result().clients, ['kimi']);
      assert.equal(mirror.result().files, 1);
      assert.equal(fs.existsSync(path.join(mirror.home, '.codex')), false);
    } finally { mirror.cleanup(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
