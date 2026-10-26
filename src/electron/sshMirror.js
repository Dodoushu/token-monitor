'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable, PassThrough, pipeline } = require('node:stream');
const { createGunzip } = require('node:zlib');
const { TextDecoder } = require('node:util');

const MAX_TRANSFER_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_FILES = 20000;
const MAX_METADATA_BYTES = 64 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

// These are session sources, not entire application roots. Credentials, config,
// arbitrary project files and live SQLite databases never enter the archive.
const SOURCE_RULES = [
  { client: 'claude', root: '.claude/projects', names: ['*.jsonl'] },
  { client: 'claude', root: '.claude/transcripts', names: ['*.jsonl'] },
  { client: 'codex', root: '.codex/sessions', names: ['*.jsonl', '*.jsonl.zst'] },
  { client: 'codex', root: '.codex/archived_sessions', names: ['*.jsonl', '*.jsonl.zst'] },
  { client: 'kimi', root: '.kimi/sessions', names: ['wire.jsonl'] },
  { client: 'kimi', root: '.kimi-code/sessions', names: ['wire.jsonl'] },
  { client: 'droid', root: '.factory/sessions', names: ['*.settings.json', '*.jsonl'] },
  { client: 'qwen', root: '.qwen/projects', names: ['*.jsonl'] },
  { client: 'gemini', root: '.gemini/tmp', names: ['session-*.json'] },
  ...['.openclaw', '.clawdbot', '.moltbot', '.moldbot'].map((name) => ({ client: 'openclaw', root: `${name}/agents`, names: ['*.jsonl'] })),
  { client: 'pi', root: '.pi/agent/sessions', names: ['*.jsonl'] },
  { client: 'grok', root: '.grok/sessions', names: ['summary.json'] },
  { client: 'grok', root: '.grok/logs', names: ['unified.jsonl'] },
  { client: 'commandcode', root: '.commandcode/projects', names: ['*.jsonl'] },
  { client: 'codebuddy', root: '.codebuddy/projects', names: ['*.jsonl'] },
  { client: 'dsh', root: '.dsh/sessions', names: ['session*.jsonl', 'session*.jsonl.zstd'] }
];

function mirrorError(code = 'ssh-unsafe-archive') {
  const message = code === 'ssh-unsafe-archive' ? 'The SSH session archive was unsafe or incomplete.'
    : code === 'ssh-local-storage-failed' ? 'The local SSH mirror could not be stored completely.'
      : 'The SSH session archive exceeded its safety limit.';
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalName(raw) {
  let name = raw;
  while (name.startsWith('./')) name = name.slice(2);
  if (!name || name.length > 4096 || name.startsWith('/') || /[\\:\x00-\x1f\x7f]/.test(name)
    || name.split('/').some((part) => !part || part === '.' || part === '..')) return null;
  return name;
}

function sourceFor(name) {
  const canonical = canonicalName(name);
  if (!canonical) return null;
  for (const source of SOURCE_RULES) {
    if (!canonical.startsWith(source.root + '/')) continue;
    const relative = canonical.slice(source.root.length + 1);
    const basename = relative.split('/').at(-1);
    if (source.client === 'openclaw' && !/^[^/]+\/sessions\/[^/]+\.jsonl$/.test(relative)) continue;
    if (source.client === 'gemini' && !/^[^/]+\/chats\/session-[^/]+\.json$/.test(relative)) continue;
    if (source.client === 'dsh' && !/^session(?:\.[A-Za-z0-9_-]+)?\.jsonl(?:\.zstd)?$/.test(basename)) continue;
    if (source.root === '.grok/logs' && relative !== 'unified.jsonl') continue;
    if (source.names.some((pattern) => new RegExp('^' + pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(basename))) {
      return { ...source, name: canonical };
    }
  }
  return null;
}

function isAllowedSessionPath(name) { return typeof name === 'string' && Boolean(sourceFor(name)); }
function quote(value) { return `'${value.replace(/'/g, `'"'"'`)}'`; }

function buildRemoteArchiveCommand(remoteHome = '~') {
  const directory = remoteHome === '~' ? '"$HOME"' : remoteHome.startsWith('~/')
    ? `"$HOME"/${quote(remoteHome.slice(2))}` : quote(remoteHome);
  const scans = SOURCE_RULES.map(({ root, names, client }) => {
    const match = names.map((name) => `-name ${quote(name)}`).join(' -o ');
    // The second -path guard prevents unrelated JSONL below an agent tree or
    // Gemini scratch directory from being sent at all, before local validation.
    const lane = client === 'openclaw' ? ` -path ${quote(root + '/*/sessions/*.jsonl')}`
      : client === 'gemini' ? ` -path ${quote(root + '/*/chats/session-*.json')}` : '';
    return `if [ -d ${quote(root)} ] && safe_root ${quote(root)}; then find ${quote(root)} -type f${lane} \\( ${match} \\) -exec tar -cf - -- {} + || failed=1; fi`;
  }).join('\n');
  const script = `unset TAR_OPTIONS GZIP
export LC_ALL=C COPYFILE_DISABLE=1
if ! cd -- "$1" 2>/dev/null; then printf '%s\\n' TMSSH_HOME_MISSING >&2; exit 71; fi
for tool in find tar; do if ! command -v "$tool" >/dev/null 2>&1; then printf '%s\\n' TMSSH_TOOLS_MISSING >&2; exit 72; fi; done
platform=$(uname -s 2>/dev/null) || platform=unknown
case "$platform" in Linux|Darwin) ;; *) platform=unknown ;; esac
printf 'TMSSH1 %s\\n' "$platform"
safe_root() {
candidate=$1
while [ -n "$candidate" ]; do
if [ -L "$candidate" ]; then return 1; fi
case "$candidate" in */*) candidate=\${candidate%/*} ;; *) break ;; esac
done
return 0
}
produce() {
failed=0
${scans}
if [ "$failed" -eq 0 ]; then printf '%s\\n' TMSSH_ARCHIVE_OK >&2; else printf '%s\\n' TMSSH_ARCHIVE_FAILED >&2; fi
return "$failed"
}
if command -v gzip >/dev/null 2>&1; then produce | gzip -c; else produce; fi`;
  return `sh -c ${quote(script)} -- ${directory}`;
}

function stringField(buffer) {
  const nul = buffer.indexOf(0);
  try { return UTF8.decode(nul === -1 ? buffer : buffer.subarray(0, nul)); }
  catch (_) { throw mirrorError(); }
}

function octalField(buffer) {
  const text = buffer.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]*$/.test(text)) throw mirrorError();
  const value = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value) || value < 0) throw mirrorError();
  return value;
}

function paxFields(buffer) {
  const result = {};
  for (let offset = 0; offset < buffer.length;) {
    const space = buffer.indexOf(32, offset);
    if (space === -1 || space - offset > 10) throw mirrorError();
    const lengthText = buffer.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw mirrorError();
    const end = offset + Number(lengthText);
    if (end > buffer.length || end <= space + 1 || buffer[end - 1] !== 10) throw mirrorError();
    let line;
    try { line = UTF8.decode(buffer.subarray(space + 1, end - 1)); } catch (_) { throw mirrorError(); }
    const equal = line.indexOf('=');
    if (equal <= 0) throw mirrorError();
    const key = line.slice(0, equal);
    if (key === 'linkpath' || /sparse/i.test(key)) throw mirrorError();
    if (['path', 'size'].includes(key)) result[key] = line.slice(equal + 1);
    offset = end;
  }
  return result;
}

class TarReceiver extends Writable {
  constructor(home, options) {
    super();
    this.home = home;
    this.maxBytes = options.maxExpandedBytes ?? MAX_EXPANDED_BYTES;
    this.maxFiles = options.maxFiles ?? MAX_FILES;
    this.pending = Buffer.alloc(0);
    this.expanded = 0;
    this.files = 0;
    this.fileBytes = 0;
    this.clients = new Set();
    this.entry = null;
    this.padding = 0;
    this.fd = null;
    this.pax = {};
    this.longName = '';
    this.sawEnd = false;
  }

  _write(chunk, _encoding, callback) {
    try {
      this.expanded += chunk.length;
      if (this.expanded > this.maxBytes) throw mirrorError('ssh-expanded-limit');
      this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
      this.consume();
      callback();
    } catch (error) { callback(error); }
  }

  consume() {
    while (this.pending.length) {
      if (this.padding) {
        const length = Math.min(this.padding, this.pending.length);
        this.pending = this.pending.subarray(length);
        this.padding -= length;
        continue;
      }
      if (this.entry) {
        const length = Math.min(this.entry.remaining, this.pending.length);
        const part = this.pending.subarray(0, length);
        if (this.fd !== null) {
          let offset = 0;
          while (offset < part.length) {
            let written;
            try { written = fs.writeSync(this.fd, part, offset, part.length - offset); }
            catch (_) { throw mirrorError('ssh-local-storage-failed'); }
            if (!Number.isInteger(written) || written <= 0) throw mirrorError('ssh-local-storage-failed');
            offset += written;
          }
        }
        else if (this.entry.metadata) this.entry.parts.push(part);
        this.entry.remaining -= length;
        this.pending = this.pending.subarray(length);
        if (this.entry.remaining === 0) this.finishEntry();
        continue;
      }
      if (this.pending.length < 512) return;
      const header = this.pending.subarray(0, 512);
      this.pending = this.pending.subarray(512);
      if (header.every((byte) => byte === 0)) { this.sawEnd = true; continue; }
      this.sawEnd = false;
      const checksum = octalField(header.subarray(148, 156));
      const computed = header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0);
      if (checksum !== computed) throw mirrorError();
      const type = String.fromCharCode(header[156] || 48);
      const size = octalField(header.subarray(124, 136));
      if (size > this.maxBytes) throw mirrorError('ssh-expanded-limit');
      const name = stringField(header.subarray(0, 100));
      const prefix = stringField(header.subarray(345, 500));
      this.entry = { type, remaining: size, size, parts: [], metadata: ['x', 'g', 'L'].includes(type) };
      if (this.entry.metadata) {
        if (size > MAX_METADATA_BYTES) throw mirrorError();
      } else if (type === '0') {
        if (this.pax.size !== undefined && (!/^[0-9]+$/.test(this.pax.size) || Number(this.pax.size) !== size)) throw mirrorError();
        const source = sourceFor(this.pax.path || this.longName || (prefix ? `${prefix}/${name}` : name));
        this.pax = {};
        this.longName = '';
        if (!source) throw mirrorError();
        if (++this.files > this.maxFiles) throw mirrorError('ssh-file-limit');
        const filename = path.join(this.home, ...source.name.split('/'));
        fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
        try { this.fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600); }
        catch (_) { throw mirrorError(); }
        this.fileBytes += size;
        this.clients.add(source.client);
      } else {
        // No link, directory, device, FIFO or sparse entry is ever materialized.
        throw mirrorError();
      }
      if (!size) this.finishEntry();
    }
  }

  finishEntry() {
    if (this.fd !== null) { fs.closeSync(this.fd); this.fd = null; }
    if (this.entry.metadata) {
      const buffer = Buffer.concat(this.entry.parts);
      if (this.entry.type === 'L') this.longName = stringField(buffer);
      else {
        const fields = paxFields(buffer);
        if (this.entry.type === 'g' && Object.keys(fields).length) throw mirrorError();
        if (this.entry.type === 'x') this.pax = { ...this.pax, ...fields };
      }
    }
    this.padding = (512 - this.entry.size % 512) % 512;
    this.entry = null;
  }

  _final(callback) {
    callback(this.entry || this.padding || this.pending.length || this.longName || Object.keys(this.pax).length
      || (this.expanded > 0 && !this.sawEnd) ? mirrorError() : null);
  }

  _destroy(error, callback) {
    if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (_) {} this.fd = null; }
    callback(error);
  }
}

function createSshMirror(options = {}) {
  const home = fs.mkdtempSync(path.join(options.tmpdir || os.tmpdir(), 'token-monitor-ssh-mirror-'));
  fs.chmodSync(home, 0o700);
  const receiver = new TarReceiver(home, options);
  let transferred = 0;
  let prefix = Buffer.alloc(0);
  let framed = false;
  let remotePlatform = 'ssh-posix';
  let decoder;
  let finalCallback;
  let pipelineEnded = false;
  let pipelineError;
  const safeError = (error) => receiver.errored?.code?.startsWith('ssh-') ? receiver.errored
    : error?.code?.startsWith('ssh-') ? error : mirrorError();
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      try {
        transferred += chunk.length;
        if (transferred > (options.maxTransferBytes ?? MAX_TRANSFER_BYTES)) throw mirrorError('ssh-transfer-limit');
        if (!decoder) {
          prefix = prefix.length ? Buffer.concat([prefix, chunk]) : chunk;
          if (!framed) {
            const newline = prefix.indexOf(10);
            if (newline === -1) {
              if (prefix.length > 128) throw mirrorError();
              callback();
              return;
            }
            const match = /^TMSSH1 (Linux|Darwin|unknown)$/.exec(prefix.subarray(0, newline).toString('ascii'));
            if (!match || newline > 128) throw mirrorError();
            remotePlatform = match[1] === 'Linux' ? 'linux' : match[1] === 'Darwin' ? 'darwin' : 'ssh-posix';
            framed = true;
            prefix = prefix.subarray(newline + 1);
          }
          if (prefix.length < 2) { callback(); return; }
          decoder = prefix[0] === 0x1f && prefix[1] === 0x8b ? createGunzip() : new PassThrough();
          pipeline(decoder, receiver, (error) => {
            pipelineEnded = true;
            pipelineError = error?.code?.startsWith('ssh-') ? error : error ? mirrorError() : null;
            if (pipelineError) stream.destroy(pipelineError);
            finalCallback?.(pipelineError);
          });
          const first = prefix;
          prefix = Buffer.alloc(0);
          decoder.write(first, (error) => callback(error || receiver.errored ? safeError(error) : null));
          return;
        }
        if (receiver.errored) { callback(safeError(receiver.errored)); return; }
        decoder.write(chunk, (error) => callback(error || receiver.errored ? safeError(error) : null));
      } catch (error) { callback(error); }
    },
    final(callback) {
      if (!framed) { callback(mirrorError()); return; }
      if (!decoder) {
        if (prefix.length) { callback(mirrorError()); return; }
        receiver.end();
        callback();
        return;
      }
      if (pipelineEnded) { callback(pipelineError); return; }
      finalCallback = callback;
      decoder.end();
    },
    destroy(error, callback) {
      decoder?.destroy();
      receiver.destroy();
      callback(error ? safeError(error) : null);
    }
  });
  return { home, stream, result: () => ({ home, remotePlatform, files: receiver.files, bytes: receiver.fileBytes,
    expandedBytes: receiver.expanded, transferBytes: transferred, clients: [...receiver.clients] }),
  cleanup() { stream.destroy(); fs.rmSync(home, { recursive: true, force: true }); } };
}

module.exports = { MAX_TRANSFER_BYTES, MAX_EXPANDED_BYTES, MAX_FILES, SOURCE_RULES,
  buildRemoteArchiveCommand, createSshMirror, isAllowedSessionPath };
