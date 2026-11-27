# Deploy `vela daemon` and channel gateways

`vela daemon run` runs the single-writer Vela daemon in the foreground without a terminal, serving CLI clients, SDK `connectRuntime()` callers over `<VELA_DIR>/vela.sock`, **Lark (`config.json` `lark`)**, and **`webhooks` (`POST /events/github` and `POST /events/generic`)** with automatic `config.json` / `SIGHUP` reload and live enablement via `vela.db`. (`vela serve` and the legacy SDK channel gateway are retired.)

The daemon has no sandbox: the operating-system account it runs under is the boundary, and anyone with access to its socket can use everything that account can. Run it as a dedicated user that holds only the files, keys and network access needed (see [Security](security.md#channel-senders)), from a systemd unit.

The steps below are for a Debian or Ubuntu host with systemd; adjust the package commands for other distributions. They use `vela` as the account name.

## 1. Create the account

```sh
sudo useradd --create-home --shell /usr/sbin/nologin vela
sudo -u vela mkdir -p /home/vela/workspace /home/vela/.vela
sudo chmod 700 /home/vela/.vela
```

The account has no shell and no sudo. `/home/vela/workspace` is the working folder Vela starts in; it selects the project data directory described under [Data and backups](#7-data-and-backups).

## 2. Install Node.js and Vela

Vela needs Node.js 22.18 or newer. Install it system-wide, not with a version manager: systemd does not read shell profiles, so `nvm`, `fnm` or `volta` would not be on the service's `PATH`.

```sh
sudo apt-get install -y ca-certificates curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g @glows777/vela
```

`npm install -g` usually puts the command in `/usr/bin/vela` or `/usr/local/bin/vela`. `command -v vela` prints the path to use in `ExecStart` below.

## 3. Configure the bot

User-level configuration lives in `VELA_DIR`, which the unit sets to `/home/vela/.vela`:

- `config.json`: the channel configuration, for example `lark` with `appId`, `owners` and `chats` (see [Channels](channels.md#lark)).
- An environment file for secrets, so they stay out of `config.json`.

Vela reads `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_OWNERS` and provider keys such as `ANTHROPIC_API_KEY` from the environment, and `config.json` can reference them as `$LARK_APP_SECRET` ([CLI environment variables](cli.md#environment-variables)). Create the file with mode `0600`, owned by the service user:

```sh
sudo install -d -m 755 /etc/vela
sudo install -m 600 -o vela -g vela /dev/null /etc/vela/vela.env
sudo -u vela tee /etc/vela/vela.env >/dev/null <<'EOF'
ANTHROPIC_API_KEY=...
LARK_APP_SECRET=...
EOF
```

systemd reads this file as root before it drops to `User=vela`, so the unit does not need to run as root.

## 4. Install the unit

Write `/etc/systemd/system/vela.service`:

```ini
[Unit]
Description=Vela daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vela
Group=vela
WorkingDirectory=/home/vela/workspace
Environment=VELA_DIR=/home/vela/.vela
EnvironmentFile=/etc/vela/vela.env
ExecStart=/usr/bin/vela daemon run
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- `ExecStart` takes the absolute path from `command -v vela`. `daemon run` stays in the foreground until SIGTERM, which is what `Type=simple` expects.
- `WorkingDirectory` is the default workspace directory for the service.
- `EnvironmentFile` holds the secrets. A missing file fails the start instead of running without a key.
- `Restart=on-failure` restarts after a crash or a non-zero exit, so a broken `config.json` shows up as repeated restarts in the journal rather than as a running service.
- There is no `StandardOutput=` or shell redirection: `vela daemon run` writes logs to stderr, which journald already collects. Vela does not rotate its own log.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now vela
systemctl status --no-pager vela
```

`status` then shows `Active: active (running)` with the `vela daemon run` process as its main PID. `systemctl stop` sends SIGTERM; Vela reaps active background jobs, saves and closes sessions, removes `vela.sock` and exits 0.

## 5. Logs

```sh
journalctl -u vela -f
journalctl -u vela -n 100 --no-pager
journalctl -u vela --since today
```

The journal holds the daemon's startup lines and operational logs ([CLI daemon](cli.md#daemon)). journald rotates and limits the journal, so no logrotate rule is needed.

## 6. Upgrade

For `vela daemon`:

```sh
sudo npm install -g @glows777/vela@latest
sudo systemctl restart vela
systemctl status --no-pager vela
```

The running process keeps the old code until the restart. A run in progress is stopped: SIGTERM saves and closes the sessions. Conversations are stored in `$VELA_DIR/vela.db`, so they remain available after the restart.

### Upgrading Docker / group workspaces (`<projectDataDir>` → `<VELA_DIR>`)

If a group or Docker environment previously kept files under an older `<projectDataDir>/channels/.../workspace` path (or if you changed `$VELA_DIR` / `dataDir` or the configured Docker `environment` name), copy those workspace files into `<VELA_DIR>` before starting the daemon; otherwise `/workspace` in the container will mount a fresh empty directory.

To verify the cutover cleanly (do not only check that `/workspace` exists):

1. Place a known marker file in the migrated group workspace under `<VELA_DIR>` and confirm the test group reads that marker file.
2. Restart `vela daemon` (`sudo systemctl restart vela` or `vela daemon stop && vela daemon start`).
3. Confirm the test group reads the same marker file a second time after the restart.

## 7. Data and backups

`VELA_DIR=/home/vela/.vela` holds:

| Path | What |
|---|---|
| `config.json`, `vela.db` | Unified configuration (model, channels, providers) and saved project-trust decisions (`trusted_paths`) |
| `auth.json` | Provider credentials saved by `/login`, mode `0600` |
| `projects/<working folder>/vela.db` | SQLite WAL database holding conversations, tool calls, runs, approvals, and usage records (mode `0600` in `0700` directories) |
| `projects/<working folder>/sessions/` | Per-session spilled long tool outputs (`tool-results/`) and upload metadata |
| `projects/<working folder>/channels/<chat>/` | Each group's shared `workspace/`, `memory/` and attachments |

Back up that directory rather than the workspace alone: it holds the credentials and the full transcripts, including tool output.

## Limits

Vela does not sandbox its tools. `bash` runs as `vela`, with that account's environment, home directory and network access, so anyone in an enabled chat can read `/etc/vela/vela.env`, `~/.vela/auth.json` and anything else `vela` can reach. Keep the account empty: no sudo, no SSH keys, no unrelated code. When the people in the chats are not fully trusted, add a container or a virtual machine that holds only the files and network the bot needs.
