# Collect usage over SSH

Choose **Collect over SSH** in Settings → Multi-device Sync, add hosts, and save a polling interval. This mode combines local usage with each connection's latest successful record. No remote Hub or inbound connection to this desktop is needed.

## Prepare the remote host

The remote host must run Linux or macOS with a POSIX shell, Node.js 22.15+ (24 LTS recommended), and a Token Monitor checkout with its production dependencies and scanner installed. Node must be available in a non-interactive SSH session.

```sh
git clone https://github.com/Javis603/token-monitor.git ~/token-monitor
cd ~/token-monitor
npm ci --omit=dev
npm run ensure:tokscale
```

Check `ssh my-host 'node --version'` in a terminal. On first connection, verify and trust the host fingerprint there. Token Monitor never accepts an unknown or changed host key automatically.

Set **Remote project directory** to the checkout, such as `~/token-monitor`. Each poll runs:

```sh
cd ~/token-monitor && node src/agent/agent.js --once --dry-run --limits=false
```

The app does not install or update remote software. The agent reads that SSH user's tool data using its normal configuration. It returns usage, costs, sessions, projects and enabled History; provider-limit checks and Hub uploads are disabled for this invocation. The imported record excludes session titles and conversation text using the existing sync projection. All-time session detail follows the same omission rules as Hub sync.

## Authentication

- **Local SSH alias:** enter a `Host` alias from this computer's SSH configuration. System OpenSSH resolves the hostname, username, keys, agent and ProxyJump settings. This unattended mode never prompts for a password or key passphrase; unlock the key in an SSH agent first.
- **Username and password:** enter a host, port, username and password. Available on macOS and Linux desktops. Windows desktops support alias/key/agent authentication; password mode is unavailable there.
- **Test connection:** performs a real one-shot collection and can take as long as a full scan. A successful test reports the remote Device ID without saving the draft. Save separately to include it in polling.

Passwords use the existing main-process `credentials.json` store (POSIX `0600`, or the Windows user-data ACL). The store is plaintext and does not protect against another process running as the same OS user. The renderer receives only configured/not-configured state. Passwords never enter ordinary settings, SSH arguments, error output or synced data. A temporary POSIX `0700` askpass helper reads the password from the SSH child's environment and is removed after the process closes.

A blank password edit retains the saved password for the same host, port and username. Changing those fields requires a new password. Clearing the password keeps the connection awaiting a new credential.

## Scheduling and recovery

The interval accepts whole seconds from **15 seconds to 24 hours**, defaulting to **5 minutes**. The first collection starts when SSH mode is activated or its configuration changes. Hosts are collected serially; each completed round waits the configured interval. **Collect now** starts a round immediately; concurrent requests share the same round. Each operation has a three-minute deadline and bounded output.

A failed poll retains the last successful in-memory record and retries next round. Per-host errors remain visible. Devices become stale after twice the polling interval, with a ten-minute minimum. Restarting the app starts fresh collection. Editing an endpoint or remote directory invalidates its cached record. Removing a connection removes its record and saved password. Duplicate configured targets are rejected; different aliases resolving to the same remote user's checkout should also be avoided.

Mode changes and quit cancel active SSH work. An unconfirmed forced SSH exit blocks further SSH launches until the app restarts; other sync methods remain usable. Connection IDs namespace imported device identities, so a remote hostname cannot replace the local record.
