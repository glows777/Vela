# Deploy `vela daemon` and channel gateways

`vela daemon run` runs the single-writer Vela daemon in the foreground without a terminal, serving CLI clients and SDK `connectRuntime()` callers over `<VELA_DIR>/vela.sock`.

> **Channel gateway transition note (`S4b-2`):** `vela serve` is retired. `vela daemon run` now hosts **Lark (`config.json` `lark`)** and **`webhooks` (`POST /events/github` and `POST /events/generic`)** natively with automatic `config.json` / `SIGHUP` reload and live enablement via `vela.db`. Only the transitional **Local HTTP/SSE** listener remains on the legacy SDK host (`createVela()` + `startChannels()`, omitting `lark`) until `S4b-3` retires `legacy-channels`. Do not run both `vela daemon` and a separate legacy SDK host with the same Lark app credentials or webhook port.

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

If you are running the transitional SDK gateway under `/home/vela/gateway` (below), upgrade its local `@glows777/vela` dependency instead (and upgrade the global CLI separately with `sudo npm install -g @glows777/vela@latest` if installed):

```sh
sudo -u vela npm --prefix /home/vela/gateway install @glows777/vela@latest
sudo systemctl restart vela
systemctl status --no-pager vela
```

The running process keeps the old code until the restart. A run in progress is stopped: SIGTERM saves and closes the sessions. Conversations are stored on disk, so they are still there after the restart.

## Serving channels during the transition

Until S4b-2 migrates **Lark and Local HTTP/SSE channels** onto `vela daemon`, run legacy Lark / Local adapters (and webhooks targeting legacy Lark subscriptions) on the legacy SDK host (`createVela()` + `startChannels()`). If `vela daemon` is running on the same host with `webhooks` configured, remove `webhooks` from `config.json` for that daemon or pass `extensionConfig: { ...config.extensionConfig, channel: undefined }` on one of the two processes so only the intended subscription store owns the port.

Node.js ESM does **not** resolve bare package imports (`import ... from '@glows777/vela'`) from a global `npm install -g` installation. Create a dedicated directory with a local `@glows777/vela` install under the `vela` user:

```sh
sudo -u vela mkdir -p /home/vela/gateway
sudo -u vela sh -c 'cd /home/vela/gateway && npm init -y && npm install @glows777/vela'
```

Write `/home/vela/gateway/gateway.mjs`:

```js
import { createVela, lark, larkConfig, local, loadConfig } from '@glows777/vela'

const config = loadConfig({
  cwd: process.cwd(),
  agentDir: process.env.VELA_DIR,
  env: process.env,
  extensionConfigs: [larkConfig],
})
const larkCfg = config.extensionConfig.lark
const localCfg = config.settings.local
const extensions = [
  ...(larkCfg?.appId && larkCfg?.appSecret ? [lark()] : []),
  ...(localCfg?.enabled && typeof localCfg.token === 'string' && localCfg.token
    ? [
        local({
          token: localCfg.token,
          ...(typeof localCfg.port === 'number' ? { port: localCfg.port } : {}),
          ...(typeof localCfg.timezone === 'string'
            ? { timezone: localCfg.timezone }
            : {}),
        }),
      ]
    : []),
]
const vela = createVela({
  cwd: config.cwd,
  agentDir: config.agentDir,
  dataDir: config.dataDir,
  model: config.settings.model,
  thinkingLevel: config.settings.thinkingLevel,
  providers: config.providers,
  credentials: config.credentials,
  limits: config.settings.limits,
  extensions,
  extensionConfig: config.extensionConfig,
  eventDefaultTarget: config.settings.eventDefaultTarget,
})
let shuttingDown = false
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(130)
    shuttingDown = true
    const timer = setTimeout(() => process.exit(143), 30_000)
    timer.unref()
    void vela.dispose({ graceful: true }).finally(() => {
      clearTimeout(timer)
      process.exit(0)
    })
  })
}
await vela.ready()
await vela.startChannels()
```

`loadConfig()` already maps top-level `webhooks` from `config.json` into `config.extensionConfig.channel.eventReceiver`, so forwarding `extensionConfig: config.extensionConfig` enables both GitHub and generic webhooks on this host as well.

In `/etc/systemd/system/vela.service`, keep `WorkingDirectory=/home/vela/workspace`, `Environment=VELA_DIR=/home/vela/.vela`, and `EnvironmentFile=/etc/vela/vela.env`, and set:

```ini
ExecStart=/usr/bin/node /home/vela/gateway/gateway.mjs
```

When upgrading later, follow the `/home/vela/gateway` commands in [Upgrade](#6-upgrade).

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
