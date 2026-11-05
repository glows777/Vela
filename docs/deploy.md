# Deploy `vela serve`

`vela serve` runs the configured channels without a terminal, so a chat bot keeps answering after the shell closes and after a reboot. It has no sandbox: the operating-system account it runs under is the boundary, and anyone in an enabled chat can use everything that account can. Run it as a dedicated user that holds only the files, keys and network access the bot needs (see [Security](security.md#channel-senders)), from a systemd unit.

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

- `settings.json`: the channel configuration, for example `extensionConfig.lark` with `appId`, `owners` and `chats` (see [Channels](channels.md#lark)).
- An environment file for secrets, so they stay out of `settings.json`.

Vela reads `LARK_APP_ID`, `LARK_APP_SECRET`, `LARK_OWNERS` and provider keys such as `ANTHROPIC_API_KEY` from the environment, and `settings.json` can reference them as `$LARK_APP_SECRET` ([CLI environment variables](cli.md#environment-variables)). Create the file with mode `0600`, owned by the service user:

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
Description=Vela agent serving chat channels
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=vela
Group=vela
WorkingDirectory=/home/vela/workspace
Environment=VELA_DIR=/home/vela/.vela
EnvironmentFile=/etc/vela/vela.env
ExecStart=/usr/bin/vela serve
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

- `ExecStart` takes the absolute path from `command -v vela`. `serve` stays in the foreground until SIGTERM, which is what `Type=simple` expects.
- `WorkingDirectory` is the folder Vela starts in, and it selects the project data directory.
- `EnvironmentFile` holds the secrets. A missing file fails the start instead of running without a key.
- `Restart=on-failure` restarts after a crash or a non-zero exit. `serve` exits 1 when no channel starts, so a broken `settings.json` shows up as repeated restarts in the journal rather than as a running service.
- There is no `StandardOutput=` or shell redirection: `vela serve` writes one line per event to stderr, which journald already collects. Vela does not rotate its own log.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now vela
systemctl status --no-pager vela
```

`status` then shows `Active: active (running)` with the `vela serve` process as its main PID. `systemctl stop` sends SIGTERM; Vela saves and closes the sessions, closes the channels and exits 0.

## 5. Logs

```sh
journalctl -u vela -f
journalctl -u vela -n 100 --no-pager
journalctl -u vela --since today
```

The journal holds the gateway's startup lines and one line per channel event, with a local timestamp: `channel_message`, `channel_reply` and `channel_error` ([CLI serve](cli.md#serve)). Text is cut to one line of 80 characters, and terminal escape sequences are stripped. journald rotates and limits the journal, so no logrotate rule is needed.

## 6. Upgrade

```sh
sudo npm install -g @glows777/vela
sudo systemctl restart vela
systemctl status --no-pager vela
```

The running process keeps the old code until the restart. A run in progress is stopped: SIGTERM saves and closes the sessions. Conversations are stored on disk, so they are still there after the restart.

## 7. Data and backups

`VELA_DIR=/home/vela/.vela` holds:

| Path | What |
|---|---|
| `settings.json`, `trust.json` | Channel configuration and saved project-trust answers |
| `auth.json` | Provider credentials saved by `/login`, mode `0600` |
| `projects/<working folder>/sessions/` | Every conversation, mode `0600` in `0700` directories |
| `projects/<working folder>/usage/requests.jsonl` | Token usage |
| `projects/<working folder>/channels/<chat>/` | Each group's shared `workspace/`, `memory/` and attachments |

Back up that directory rather than the workspace alone: it holds the credentials and the full transcripts, including tool output.

## Limits

Vela does not sandbox its tools. `bash` runs as `vela`, with that account's environment, home directory and network access, so anyone in an enabled chat can read `/etc/vela/vela.env`, `~/.vela/auth.json` and anything else `vela` can reach. Keep the account empty: no sudo, no SSH keys, no unrelated code. When the people in the chats are not fully trusted, add a container or a virtual machine that holds only the files and network the bot needs.
