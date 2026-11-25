# Settings

Vela reads its configuration from `~/.vela/config.json` (or `$VELA_DIR/config.json`) and, for trusted projects, from `<project>/.vela/config.json`. This page covers `config.json`, the data directory, project trust, context files (`AGENTS.md`), skills and prompt templates. Model provider fields inside `providers` are described in [Models](models.md).

## Files

| File | Scope |
|---|---|
| `~/.vela/config.json` | User configuration (model, tools, providers, channels, MCP servers, limits, resources). |
| `<project>/.vela/config.json` | Project configuration. Read only when the project is [trusted](#project-trust). Host-owned keys (`environments`, `location`, `providers`, `lark`, `local`, `webhooks`, `eventDefaultTarget`) are ignored in project config. |
| `~/.vela/trust.json` | Saved project trust decisions. |
| `~/.vela/extensions/` | User extensions, loaded in every project. |
| `<project>/.vela/extensions/` | Project extensions. Loaded only when the project is trusted. |
| `~/.vela/skills/`, `~/.agents/skills/`, `<project>/.vela/skills/`, `<project>/.agents/skills/`, `<project>/.skills/` | Skills. Project skills load only when the project is trusted. See [Skills](#skills). |
| `~/.vela/prompts/`, `<project>/.vela/prompts/` | Prompt templates. Project templates load only when the project is trusted. See [Prompt templates](#prompt-templates). |
| `~/.vela/AGENTS.md`, `AGENTS.md` / `CLAUDE.md` in the working folder and its parents | Instructions put into the system prompt. Not gated by trust. See [Context files](#context-files). |
| `~/.vela/SYSTEM.md`, `<project>/.vela/SYSTEM.md` | Replaces the default system prompt. The project file needs trust. See [The system prompt](#the-system-prompt). |
| `~/.vela/APPEND_SYSTEM.md`, `<project>/.vela/APPEND_SYSTEM.md` | Text appended to the system prompt. The project file needs trust. See [The system prompt](#the-system-prompt). |

All files are optional. A file that is not valid JSON, an unrecognized top-level key, a built-in extension section nested under `extensionConfig`, or a key with the wrong type stops the CLI with a `[config]` error and exit code 2. On CLI or Desktop startup, legacy user-level `settings.json`, `models.json`, or `mcp.json` files without `config.json` are automatically flattened into `~/.vela/config.json` in read-only mode (originals stay untouched); direct SDK loaders (`loadConfig()`, `loadModels()`) and trusted project `.vela/` directories still fail fast until `config.json` exists.

When you start Vela from your home directory, `<project>/.vela` is `~/.vela` itself; it is read once, as user configuration, and no trust question is asked.

## Settings follow the session location

For sessions opened or resumed in another project, declared `skills` and `prompts`, `model`, `thinkingLevel`, `limits`, `autoCompaction`, and `shellPath` come from that session's trusted `.vela/config.json`, not the directory where Vela started. Relative declared resource paths resolve beside that config file. A denied project contributes none of these values or resources; it does not fall back to the startup project's configuration. User settings remain the shared base, and explicit CLI/SDK overrides retain priority. Saved model/thinking selections and later manual selections are not replaced by project defaults.

Resources and defaults are prepared once for the session's location. Opening B between two turns in A does not rebuild A's prompt or tools. Editing A's settings leaves an already-prepared A session unchanged; a new A session reads the updated settings. This keeps normal wakes stable rather than inserting changing configuration into the system prompt.

`dataDir` is a bootstrap exception: the host resolves its storage directory at startup, before it can locate saved sessions. It does not move when a session resumes elsewhere. `serve` continues to ignore project `tools`; channel tool selection retains its existing rules.

Project extension registrations and configuration-driven MCP connections also follow the prepared session location and configuration snapshot. Sessions at the same location and snapshot share an instance until the last session closes; new sessions see changed settings without mutating existing ones. User custom extensions remain host singletons with user configuration, and explicit SDK/CLI extension factories remain host-owned. Providers, credentials, `environments`, `location`, listeners (`lark`, `local`, `webhooks`, `eventDefaultTarget`) and `dataDir` remain host-level configuration. CLI `tools` and the model-cycling list (`enabledModels`) come from the prepared session’s user/project config, including after resume or RPC session switches. Explicit CLI tool flags still apply on top, and the unscoped model picker and `--list-models` still list the host’s available models. If a session switch finds an invalid project tool list, the CLI reports the problem and keeps the current session.

## Merge rules

Project settings are applied on top of user settings:

- Objects (`limits`, `web`, `memory`, `extensionConfig`) are merged key by key, recursively (`$VAR` interpolation runs once per layer before merging).
- `mcpServers` entries follow replacement/override semantics: a project entry with `command`, `url`, or `type` replaces the owner entry of that name outright; an entry without those keys overrides only `enabled`, `exposure`, and `toolExposure` (missing `${VAR}` references in `mcpServers` fail strict validation rather than expanding to empty strings; see [MCP servers](mcp.md)).
- `extensions`, `skills` and `prompts` lists are concatenated: user entries first, then project entries.
- `tools` with plain names replaces the user list; a list of only `+name` / `-name` entries is appended, and an empty list replaces it with no tools (see [tools](#tools)).
- Host-owned keys (`environments`, `location`, `providers`, `lark`, `local`, `webhooks`, `eventDefaultTarget`) are stripped from `<project>/.vela/config.json` before merging.
- Every other value is replaced by the project's value.

Relative paths in `extensions`, `skills` and `prompts` resolve from the directory of the config file that lists them. `~` expands to the home directory.

## Local listener settings

Local is opt-in through **user-level** `local` in `~/.vela/config.json` (or `$VELA_DIR/config.json`). Project config cannot enable, disable or override this listener. It starts only in real `vela serve`, never interactive, print, JSON, RPC or `--list-models` mode; `--no-extensions` disables it.

```json
{
  "local": {
    "enabled": true,
    "token": "$VELA_LOCAL_TOKEN",
    "port": 8788,
    "timezone": "UTC"
  }
}
```

- `enabled`: defaults to off; must be `true` to start Local.
- `token`: required when enabled, after the usual `$VAR` / `${VAR}` expansion. Must be nonempty, not whitespace-only and contain no CR/LF. There is no implicit token environment fallback; reference your chosen variable explicitly.
- `port`: integer 0–65535, default 8788. Use a fixed port for an app; 0 asks the OS for an ephemeral port reported in startup diagnostics.
- `timezone`: optional valid IANA timezone for channel routines, otherwise the process timezone.

Local always binds `127.0.0.1` and requires Bearer authentication, including SSE and info. It has no cookie authentication or CORS support. The token grants the daemon's configured tool authority. **Do not tunnel Local**; keep it separate from the webhook listener on 8787. Restart the daemon after changes.

An opened Local project's canonical cwd selects its tool directory and trusted project settings, resources and extension snapshot when its session prepares; a denied project uses the user baseline, never the daemon startup project's layer. It does not change the daemon listener configuration or data directory and is not a sandbox. Registry, deployment identity and visible history live under the daemon's `<dataDir>/local`; channel sessions use the existing stores. Keep the serve working directory/data directory stable across restarts because the CLI default data directory is cwd-specific. See [Local startup and protocol](channels.md#local) for client examples, SDK explicit-token configuration and persistence boundaries. No existing channel-data migration is required.

## Keys

```json
{
  "model": "anthropic/<model-id>",
  "thinkingLevel": "medium",
  "tools": ["+grep", "+find"],
  "dataDir": ".vela-data",
  "shellPath": "/bin/zsh",
  "limits": { "maxRetries": 5 },
  "extensions": ["-builtin:lark", "./extensions/todo.ts"],
  "skills": ["~/shared-skills"],
  "prompts": ["~/shared-prompts"],
  "web": { "tavilyKey": "$TAVILY_API_KEY" }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `model` | `"provider/id"` | none | Model for new sessions. A trusted project's `.vela/config.json` sets it for sessions started in that project. See [Models](models.md#selecting-a-model). |
| `enabledModels` | string[] | none | Models Ctrl+P (and RPC `cycle_model`) cycles through, like pi's `enabledModels`. See [Enabled models](#enabled-models). |
| `thinkingLevel` | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` | `medium` | Thinking level for new sessions. A trusted project's `.vela/config.json` sets it for sessions started in that project. |
| `tools` | string[] | `read`, `write`, `edit`, `bash` | Tools a new CLI session starts with. Plain names (or `*` patterns) select exactly those; `+name` / `-name` entries turn default tools on or off. See [tools](#tools). |
| `providers` | object | `{}` | Host-only custom model providers and overrides (see [Models](models.md#providers)). |
| `mcpServers` | object | `{}` | MCP server definitions (see [MCP servers](mcp.md)). |
| `environments`, `location` | object | none | Host-only execution environments (such as Docker containers) and reserved default location (not yet applied by CLI startup). |
| `lark` | object | `{}` | Host-only built-in Lark channel settings (`appId`, `appSecret`, `owners`, `chats`, `timezone`). |
| `web` | object | `{}` | Built-in web search configuration (`tavilyKey`, `serperKey`). |
| `memory` | object | `{}` | Built-in memory extension settings (`dream`). |
| `webhooks` | object | none | Transitional host-only HTTP webhook receiver settings. |
| `local` | object | none | Transitional host-only Local listener settings. |
| `dataDir` | string | under `~/.vela/projects/` | The project's data directory (see [Data directory](#data-directory)). A relative path resolves from the working folder. |
| `eventDefaultTarget` | `{ channel: string, chatId: string }` | none (drop) | Host-only optional fallback for external events with no matching subscription. The top-level conversation must already exist and be enabled; it is never created implicitly. Both fields must be nonempty and surrounding whitespace is trimmed (also for the direct channel-aware SDK option). Matching disabled/unavailable subscriptions never fall through here. See [external events](channels-reference.md#external-event-subscriptions). |
| `shellPath` | string | `bash` on `PATH`; Git for Windows Bash on Windows | Shell the `bash` tool runs commands with (`<shellPath> -c <command>`), like pi's `shellPath`. On Windows, Vela looks for Git for Windows at its standard install paths and on `PATH`, preferring `bin\\bash.exe` so a `bash.cmd` shim cannot shadow it. |
| `limits` | object | see below | Overrides runtime limits. |
| `autoCompaction` | boolean | `true` | Compact the context automatically (pi's `compaction.enabled`). `false` turns off threshold summaries and compact-and-retry on overflow. `/compact` still works. See [Sessions](sessions.md#turning-automatic-compaction-off). |
| `extensions` | string[] | `[]` | Extension files or directories, and `builtin:` switches. |
| `skills` | string[] | `[]` | Extra skill directories or files. |
| `prompts` | string[] | `[]` | Extra prompt template directories or files. |
| `extensionConfig` | object | `{}` | Custom third-party extension configuration, keyed by extension name (built-in sections live at top level). |

<a id="defaulttools"></a>
### tools

`tools` sets the tools a session starts with, using the same `+name` / `-name` syntax as `--tools` (like pi). A list of only modifiers changes the default set and leaves tools from extensions alone:

```json
{ "tools": ["+grep", "+find"] }
```

The default set is `read`, `write`, `edit` and `bash`; `grep`, `find` and `ls` are registered but off. A list with plain names (or `*` patterns) replaces the default set and is an allowlist: tools from extensions are off unless the list names them.

User and project settings combine like pi: a project list with plain names replaces the user list, while a list of only `+name` / `-name` entries is appended to it. The merged list is resolved in one pass: plain names and `*` patterns select tools first, then the modifiers apply in order, so a project's `-bash` removes a tool the user selected with `*`. A user-level `["+grep"]` can therefore be narrowed by a project-level `["-grep"]`. An empty project list replaces the user list with no tools, so a project can turn the default tools off (pi appends an empty list and keeps the user's tools). `--tools` on the command line replaces the setting; its `+name` / `-name` entries apply on top of the setting's list.

### Enabled models

`enabledModels` lists patterns in the order Ctrl+P should visit them. A pattern with `/` matches `provider/id`; one without matches the model id under any provider. `*` matches anything, and matching ignores case. Only available models (providers with a credential) are included.

```json
{ "enabledModels": ["anthropic/claude-opus-4-8", "gpt-5.5", "openrouter/moonshotai/*"] }
```

Without the setting, or when no pattern matches, Ctrl+P cycles through all available models.

### limits

| Key | Default | Description |
|---|---|---|
| `maxRetries` | `3` | Retries for retryable model errors. |
| `retryBaseMs` | `500` | Base delay of the exponential backoff; `0` retries immediately. |
| `retryMaxMs` | `30000` | Maximum backoff delay. |
| `summaryThreshold` | `150000` | Estimated input tokens at which the history is summarized. |
| `maxInputTokens` | `183616` | Reference input token ceiling derived from `contextWindow` (compact thresholds follow it). |

The SDK takes the same keys as `createVela({ limits })`; unknown keys are an error in both places.

When the model entry has a `contextWindow` `W` (in `providers` or an extension provider's model list), `maxInputTokens` and `summaryThreshold` are derived from it instead of using the defaults above, which correspond to a 200k window:

| Limit | Derived value |
|---|---|
| `maxInputTokens` | `W - 16384`, but at least `W / 2` |
| `summaryThreshold` | `min(0.75 W, maxInputTokens - 0.1 W)` |

A 128k window gives `111616` and `96000`. Without `contextWindow` the defaults apply and the footer assumes a 200k window. The limits are recomputed when you switch models, and a value you set in `limits` always wins over the derived one. How compaction uses them is described in [Sessions](sessions.md#compaction).

### extensions

A list of extension files and directories to load, and `builtin:` switches that turn the built-in extensions off and on (`"-builtin:web"`, `"+builtin:web"`). Load order, entry formats and `--no-extensions` are described in [Extensions](extensions.md#where-extensions-load-from).

### Built-in and custom extension sections

Built-in extensions read top-level sections (`lark`, `web`, `memory`, `webhooks`, `local`, and strict-variable `mcpServers` — see [MCP servers](mcp.md)), while custom third-party extensions read `extensionConfig.<name>` as `vela.config`. String values in `lark`, `web`, `memory`, `webhooks`, `local`, and `extensionConfig` support `$NAME` or `${NAME}` once per config layer (an unset variable becomes an empty string; `$$` is a literal `$`). Placing any built-in extension name (`lark`, `web`, `mcp`, `memory`, `channel`, `local`, `background`, `todo`) under `extensionConfig` is rejected.

```json
{
  "web": { "tavilyKey": "${TAVILY_API_KEY}" },
  "lark": { "owners": "ou_xxx,ou_yyy", "timezone": "Asia/Shanghai" },
  "extensionConfig": {
    "my-plugin": { "endpoint": "${MY_PLUGIN_URL}" }
  }
}
```

The CLI fills built-in sections from environment variables first (`TAVILY_API_KEY`, `LARK_APP_ID` and the others listed in [CLI](cli.md#environment-variables)); values in `config.json` override them. The keys each built-in extension reads are listed in [Built-in extensions](built-in-extensions.md).

`lark.timezone` is the single IANA timezone for scheduled wake-ups (for example `Asia/Shanghai`); omitted, it uses the process timezone. Startup rejects invalid names. Reminder creation accepts local dates/times in this zone, and both tool confirmations and `!routines` show it explicitly. Recurring schedules follow the configured wall time; changing the zone shifts their UTC occurrences. Saved one-off instants do not change. See [scheduled wake-ups](channels.md#scheduled-wake-ups-m4) for weekday, DST and cancellation behavior.

## Data directory

Vela keeps per-project data outside the project, in `~/.vela/projects/`. The directory name is the absolute path of the working folder with the leading separator dropped and `/`, `\` and `:` replaced by `-`, wrapped in `--`, followed by the first 8 hex characters of the path's SHA-256. For `/home/me/code/app`:

```text
~/.vela/
├── config.json
├── trust.json
├── debug.log                         VELA_DEBUG=1 in interactive mode
├── bin/                              rg / fd downloaded by the CLI
├── extensions/
├── skills/
├── prompts/
├── AGENTS.md                         user-wide instructions (optional)
├── SYSTEM.md                         replaces the system prompt (optional)
├── APPEND_SYSTEM.md                  appended to the system prompt (optional)
└── projects/
    └── --home-me-code-app--1a2b3c4d/
        ├── vela.db                   sessions, messages, tool calls, runs, approvals, usage
        ├── sessions/
        │   └── <session id>/
        │       ├── tool-results/     spilled long tool outputs
        │       └── uploads/          session upload metadata
        └── memory/                   memory extension (MEMORY.md and one file per memory)
```

The hash keeps two folders whose readable names collide (`/a-b/c` and `/a/b-c`) apart. Set `dataDir` to store a project's data somewhere else. Session files are described in [Session format](session-format.md).

## Project trust

A project's `.vela/config.json`, `.vela/extensions/`, `.vela/prompts/`, `.vela/SYSTEM.md`, `.vela/APPEND_SYSTEM.md` and skills (`.vela/skills/`, `.skills/`, and `.agents/skills/` in the working folder or a parent up to the git root) can change Vela's behavior, run code on your machine or put instructions in front of the model, so Vela loads them only for trusted projects (like pi's project resources). Projects with none of these are not asked about. `AGENTS.md` and `CLAUDE.md` don't count: they load either way (see [Context files](#context-files)).

| Situation | Result |
|---|---|
| `--approve` / `--no-approve` | Trusted / not trusted for this run. Nothing is saved. |
| A decision is saved in `~/.vela/trust.json` | That decision is used. A decision for a directory also applies to the directories under it; the closest one wins. |
| Interactive mode, no saved decision | Vela asks `Trust this project and load it? (y/N)` and saves the answer. |
| Print, JSON or RPC mode, no saved decision | Not trusted. A notice on stderr says to pass `--approve`. |

When a project is not trusted, Vela prints a `[trust]` notice and runs with the user configuration only. To change a saved decision, edit or delete its entry in `~/.vela/trust.json` (or `$VELA_DIR/trust.json`), which maps absolute directory paths to `true` or `false`:

```json
{
  "/home/me/code/app": true,
  "/home/me/downloads": false
}
```

Trust only controls what loads at startup. It does not limit what tools can do afterwards, and it does not make a project's files safe to read; see [Security](security.md#project-trust).

## Context files

Like pi, Vela puts project instructions from `AGENTS.md` or `CLAUDE.md` into the system prompt. It looks in `~/.vela/` first, then in every directory from the filesystem root down to the working folder, and takes at most one file per directory, the first of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`. Files closer to the working folder come later, so their instructions read as more specific. In a git worktree nested inside its main checkout, the main checkout's file is skipped when the worktree has its own.

The files are read at startup and are not gated by project trust (same as pi): they are text for the model, which would read them anyway when it reads the project. Treat a folder's instructions as untrusted input even when you decline trust. `--no-context-files` turns them off. In the SDK, pass `contextFiles` to `createVela()`; see [SDK](sdk.md#createvela-options).

The CLI prints the paths it loaded. Print, JSON and RPC mode write one `[context]` line to stderr. Interactive mode writes that line into the chat log at startup, and `/status` lists the same paths after `Context files:`. A file in the working folder is shown relative to that folder (`AGENTS.md`). A file under the home directory is shown with `~`. A file under the agent directory that is outside the home directory is shown with `$VELA_DIR`. With `--no-context-files`, or when no file was found, there is no line.

## Skills

Skills follow the [Agent Skills](https://agentskills.io) format, like pi. A skill is a directory with a `SKILL.md`:

```text
.vela/skills/
└── code-review/
    ├── SKILL.md
    └── checklist.md
```

```markdown
---
name: code-review
description: Review the current diff for bugs. Use before committing.
---
Read the diff with `git diff`, then go through checklist.md ...
```

| Front matter | Description |
|---|---|
| `name` | Skill name: lowercase letters, digits and hyphens, at most 64 characters. Defaults to the directory name. A name that breaks these rules loads with a warning. |
| `description` | Required (a skill without one is skipped with a warning). Says what the skill does and when to use it; the model decides from this. |
| `disable-model-invocation` | `true` hides the skill from the model; only `/skill:<name>` runs it. |

The system prompt lists each skill's name, description and the path of its `SKILL.md`, and tells the model to read the file with `read` when a task matches. The body is not in the system prompt. Sessions without `read` or `bash` get no list. Relative paths in a skill resolve against its directory.

You can also send a skill yourself: `/skill:<name> [instruction]` sends the skill's body, wrapped in a `<skill>` block, followed by your instruction, as your message. This works in every mode and in the SDK's `session.prompt()`. `/skill` lists the skills.

A directory that contains `SKILL.md` is one skill and is not searched further. Other directories are searched recursively, and a `.md` file with a `description` placed directly in a listed directory is a skill too. Names starting with `.` and `node_modules` are skipped. Skills are loaded at startup from these places; when two have the same name, the first one wins and the other is reported as a warning:

1. `<project>/.vela/skills/` (trusted projects only)
2. `.agents/skills/` in the working folder and each parent up to the git root (trusted projects only)
3. `<project>/.skills/` (trusted projects only)
4. the paths listed in the `skills` setting (user, then project)
5. `~/.vela/skills/`
6. `~/.agents/skills/`

When you start Vela from your home directory, `<home>/.skills/` counts as user configuration and always loads. The SDK takes skill paths through `createVela({ skillDirs })`; see [SDK](sdk.md).

## Prompt templates

A prompt template is a Markdown file whose body is sent when you type `/<name> [args]`, where the name is the file name without `.md` (like pi):

```markdown
---
description: Review a file
argument-hint: <file> [focus]
---
Review $1. Focus on ${2:-correctness}.
```

`/review src/app.ts "error handling"` sends `Review src/app.ts. Focus on error handling.` Arguments are split like a shell (quotes group words). Placeholders: `$1`, `$2`, … for one argument, `$@` or `$ARGUMENTS` for all of them, `${N:-default}` and `${@:-default}` for a fallback, `${@:N}` for the arguments from the Nth on and `${@:N:L}` for L of them. Without a `description`, the first line of the body is shown in completion.

Templates load from `<project>/.vela/prompts/` (trusted projects only), the `prompts` setting and `~/.vela/prompts/`, one level deep; the first template with a name wins. Extension commands with the same name run instead of a template. The SDK takes template paths through `createVela({ promptTemplateDirs })`.

## The system prompt

The system prompt is built from named, tagged sections: the intro paragraph (untagged), `<tools>`, `<deferred_tools>`, `<rules>`, `<docs>`, `<addendum>`, `<project_context>`, `<skills>`, `<cwd>`, `<env>`, then one section per extension (for example `<memory>`). `/context` counts it as one part of the window, and `VELA_DEBUG=1` lists which sections are on. `<env>` names the operating system and the shell. It does not name the date, the time of day, the timezone or the git branch.

`<tools>` names every tool this session can call that has a `promptSnippet`, and `<rules>` carries the rules those tools bring with them, so a session narrowed to `read` is never told to use `bash`, `write` or `edit`.

The CLI resolves these two project files from the session’s working directory, including when resuming a saved session or opening another project through Local. Their contents are part of the session resource snapshot and stay stable across ordinary wakes.

Text in `~/.vela/SYSTEM.md`, or in `<project>/.vela/SYSTEM.md` when the project is trusted (the project file wins), replaces the default prompt: it becomes the intro paragraph and `<tools>`, `<rules>` and `<docs>` are left out. `--system-prompt <text or file>` (repeatable) replaces both for one run. In the SDK, pass `systemPrompt` to `createVela()`. Addendum, project context, skills, cwd, environment and extension sections stay.

Text in `~/.vela/APPEND_SYSTEM.md`, or in `<project>/.vela/APPEND_SYSTEM.md` when the project is trusted (the project file wins), is added to the system prompt in an `<addendum>` section. `--append-system-prompt <text or file>` (repeatable) replaces both for one run. In the SDK, pass `appendSystemPrompt` to `createVela()`.

`<docs>` points at Vela's own README, `docs/` and `examples/` folders, so the model reads the installed documentation when it is asked about the harness, its SDK or its extensions. A source checkout that was never built has no `docs/` folder and gets no such section; the SDK can name its own folders with `createVela({ docs })`, or turn the section off with `docs: false`.

## Legacy data

Older versions of Vela wrote data into `.sessions/`, `.memory/`, `.usage/`, `knowledge.db`, and per-session `transcript.jsonl` / `requests.jsonl` files. v0.9 makes a clean break to SQLite (`vela.db`) for sessions, runs, approvals, and usage with no automatic JSONL session migration. See [Upgrading to Vela v0.9](upgrading.md) for details.
