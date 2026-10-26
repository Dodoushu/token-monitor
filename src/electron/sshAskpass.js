'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// OpenSSH starts this private helper with a prompt argument. The secret lives
// only in the child's environment, never in the file or command line.
function createSshAskpass(password, options = {}) {
  if (typeof password !== 'string' || !password || /[\0\r\n]/.test(password)) {
    const error = new Error('SSH password must be a non-empty single line.');
    error.code = 'ssh-password-invalid';
    throw error;
  }
  if ((options.platform || process.platform) === 'win32') {
    const error = new Error('Password authentication requires macOS or Linux; use an SSH alias on Windows.');
    error.code = 'ssh-password-unsupported';
    throw error;
  }
  const folder = fs.mkdtempSync(path.join(options.tmpdir || os.tmpdir(), 'token-monitor-ssh-'));
  const helperPath = path.join(folder, 'askpass');
  const cleanup = () => fs.rmSync(folder, { recursive: true, force: true });
  try {
    fs.chmodSync(folder, 0o700);
    fs.writeFileSync(helperPath, '#!/bin/sh\nprintf \'%s\\n\' "$TOKEN_MONITOR_SSH_PASSWORD"\n', {
      mode: 0o700, flag: 'wx'
    });
    return {
      path: helperPath,
      env: {
        SSH_ASKPASS: helperPath,
        SSH_ASKPASS_REQUIRE: 'force',
        TOKEN_MONITOR_SSH_PASSWORD: password
      },
      cleanup
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

module.exports = { createSshAskpass };
