# Collect usage over SSH

Choose **Collect over SSH** in Settings → Multi-device Sync, add machines, and save a polling interval. This mode combines this computer's usage with each SSH connection's latest successful record. It does not need a remote Hub or an inbound connection to this desktop.

## Remote requirements and source scope

The remote Linux/macOS host needs its normal SSH service, the system commands `sh`, `find` and `tar`, and permission to read the session files. If `gzip` is available, the transfer is compressed. Token Monitor does not install software on the host and does not require remote Node.js, Python, npm, Token Monitor or a scanner.

**Remote user home directory** is optional and defaults to `~`, meaning the SSH user's `HOME`. Set it only when the supported tool directories belong to another home directory that this user can read. A legacy remote project-directory setting is not reused as a home directory.

The remote command selects regular session files from a fixed allowlist. Supported sources include Claude Code, Codex, Kimi, Droid, Qwen, Gemini, OpenClaw, Pi, Grok, Command Code, CodeBuddy and DSH. This is a subset of the desktop application's supported tools. Live SQLite databases, including OpenCode, are not copied or supported by SSH collection. Provider authentication files, general application configuration, cookies, private keys and arbitrary project files are outside the allowlist.

Session logs can contain prompts and responses. The selected files travel over SSH to this computer for local parsing; they are not sent to a Hub by SSH mode. Each collection uses a new local temporary HOME with POSIX permissions `0700`. Archive paths, file types and links are validated before extraction, and transfer size, expanded size and file count are bounded. Unsafe or incomplete archives fail without publishing a new record. The temporary mirror is removed in `finally` after success, failure or cancellation.

## Authentication

First connect from a terminal, for example `ssh my-host`, and verify the host fingerprint. Token Monitor never accepts an unknown or changed host key automatically.

- **Local SSH alias:** enter a `Host` alias from this computer's SSH configuration. System OpenSSH resolves its hostname, username, keys, agent and ProxyJump settings. Polling is unattended; unlock passphrase-protected keys in an SSH agent first.
- **Username and password:** enter a host, port, username and password. Available on macOS and Linux desktops. Windows desktops support alias/key/agent authentication; password mode is unavailable there.
- **Test collection:** performs a real one-shot transfer and local scan without saving the draft. Save the connection separately to include it in polling. A successful test reports the remote Device ID.

Passwords use the existing main-process `credentials.json` store (POSIX `0600`, or the Windows user-data ACL). The store is plaintext and does not protect against another process running as the same OS user. The renderer receives only configured/not-configured state. Passwords never enter ordinary settings, SSH arguments, error output or usage records. A temporary POSIX `0700` askpass helper reads the password from the SSH child's environment and is removed after the process closes.

A blank password edit retains the saved password for the same host, port and username. Changing those fields requires a new password. Clearing the password keeps the connection awaiting a new credential.

## Local calculation and polling

The local bundled scanner reads only the completed temporary mirror. Each invocation receives an explicit `--home` and nonempty `--client` allowlist, a cleaned environment, and the mirror as its working directory. Today, Month, All Time and the history graph are scanned serially. Day and month boundaries use this computer's timezone. Provider-limit checks and account credentials are not part of this collection. The existing sync projection removes session titles and conversation text from the imported usage record.

Each poll currently reads a complete snapshot of the supported remote session files; it is not an incremental transfer. Large histories can make the first test or collection take longer. Transfer and local scanner operations have deadlines, so an incomplete scan is reported as a failure rather than a partial success.

The interval accepts whole seconds from **15 seconds to 24 hours**, defaulting to **5 minutes**. Activating SSH mode or changing its configuration starts a round immediately. Hosts are collected serially; each completed round waits the configured interval. **Collect now** starts a round immediately, and concurrent refresh requests share that round.

A failed poll retains the last successful in-memory record and retries next round, with the error shown beside the affected machine. Devices become stale after twice the polling interval, with a ten-minute minimum. Restarting the app starts fresh collection. Editing the SSH endpoint or remote home invalidates its cached record; removing a connection removes its record and saved password. Avoid different aliases pointing to the same remote user's logs, which would count the same usage twice.

Mode changes and quit cancel active SSH work and local scanning. A confirmed-close barrier prevents replacement processes from overlapping. An unconfirmed forced exit blocks further SSH launches until the app restarts; other sync methods remain usable. Connection IDs namespace imported device identities, so matching hostnames cannot replace the local record.
