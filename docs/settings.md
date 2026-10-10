# Settings

Vela reads its configuration from JSON files in the user directory (`~/.vela`, or `VELA_DIR`) and, for trusted projects, from the project's `.vela` directory. This page covers `settings.json`, the data directory, project trust, context files (`AGENTS.md`), skills and prompt templates. Model providers live in `models.json`, described in [Models](models.md).

## Files

| File | Scope |
|---|---|
| `~/.vela/settings.json` | User settings, used in every project. |
| `<project>/.vela/settings.json` | Project settings. Read only when the project is [trusted](#project-trust). |
| `~/.vela/models.json` | Model providers. User level only. See [Models](models.md). |
| `~/.vela/trust.json` | Saved project trust decisions. |
| `~/.vela/extensions/` | User extensions, loaded in every project. |
| `<project>/.vela/extensions/` | Project extensions. Loaded only when the project is trusted. |
| `~/.vela/skills/`, `~/.agents/skills/`, `<project>/.vela/skills/`, `<project>/.agents/skills/`, `<project>/.skills/` | Skills. Project skills load only when the project is trusted. See [Skills](#skills). |
| `~/.vela/prompts/`, `<project>/.vela/prompts/` | Prompt templates. Project templates load only when the project is trusted. See [Prompt templates](#prompt-templates). |
| `~/.vela/AGENTS.md`, `AGENTS.md` / `CLAUDE.md` in the working folder and its parents | Instructions put into the system prompt. Not gated by trust. See [Context files](#context-files). |
| `~/.vela/APPEND_SYSTEM.md`, `<project>/.vela/APPEND_SYSTEM.md` | Text appended to the system prompt. The project file needs trust. See [Appending to the system prompt](#appending-to-the-system-prompt). |

All files are optional. A file that is not valid JSON, or a key with the wrong type, stops the CLI with a `[config]` error and exit code 2. Unknown top-level keys are ignored; unknown keys under `limits` are an error.

When you start Vela from your home directory, `<project>/.vela` is `~/.vela` itself; it is read once, as user configuration, and no trust question is asked.

## Merge rules

Project settings are applied on top of user settings:

- Objects (`limits`, `extensionConfig`) are merged key by key, recursively.
- `extensions`, `skills` and `prompts` lists are concatenated: user entries first, then project entries.
- Every other value is replaced by the project's value.

Relative paths in `extensions`, `skills` and `prompts` resolve from the directory of the settings file that lists them. `~` expands to the home directory.

## Keys

```json
{
  "defaultModel": "anthropic/<model-id>",
  "defaultThinkingLevel": "medium",
  "dataDir": ".vela-data",
  "shellPath": "/bin/zsh",
  "limits": { "maxRetries": 5 },
  "extensions": ["-builtin:feishu", "./extensions/todo.ts"],
  "skills": ["~/shared-skills"],
  "prompts": ["~/shared-prompts"],
  "extensionConfig": {
    "web": { "tavilyKey": "$TAVILY_API_KEY" }
  }
}
```

| Key | Type | Default | Description |
|---|---|---|---|
| `defaultModel` | `"provider/id"` | none | Model for new sessions. See [Models](models.md#selecting-a-model). |
| `defaultThinkingLevel` | `off` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` | `medium` | Thinking level for new sessions. |
| `dataDir` | string | under `~/.vela/projects/` | The project's data directory (see [Data directory](#data-directory)). A relative path resolves from the working folder. |
| `shellPath` | string | `bash` on `PATH` | Shell the `bash` tool runs commands with (`<shellPath> -lc <command>`), like pi's `shellPath`. A path that does not exist makes every `bash` call fail with an error. |
| `limits` | object | see below | Overrides runtime limits. |
| `extensions` | string[] | `[]` | Extension files or directories, and `builtin:` switches. |
| `skills` | string[] | `[]` | Extra skill directories or files. |
| `prompts` | string[] | `[]` | Extra prompt template directories or files. |
| `extensionConfig` | object | `{}` | Per-extension configuration, keyed by extension name. |

### limits

| Key | Default | Description |
|---|---|---|
| `maxRetries` | `3` | Retries for retryable model errors. |
| `retryBaseMs` | `500` | Base delay of the exponential backoff; `0` retries immediately. |
| `retryMaxMs` | `30000` | Maximum backoff delay. |
| `microcompactThreshold` | `120000` | Estimated input tokens at which old tool results are folded (microcompaction). |
| `summaryThreshold` | `150000` | Estimated input tokens at which the history is summarized. |
| `minMicroSavings` | `20000` | Microcompaction is applied only if it saves at least this many tokens. |
| `maxInputTokens` | `183616` | Hard cap for one request; the turn stops if the input is larger. |

The SDK takes the same keys as `createVela({ limits })`; unknown keys are an error in both places.

When the model entry has a `contextWindow` `W` (in `models.json` or an extension provider's model list), the four token limits are derived from it instead of using the defaults above, which correspond to a 200k window:

| Limit | Derived value |
|---|---|
| `maxInputTokens` | `W - 16384`, but at least `W / 2` |
| `summaryThreshold` | `min(0.75 W, maxInputTokens - 0.1 W)` |
| `microcompactThreshold` | `min(0.6 W, 0.8 × summaryThreshold)` |
| `minMicroSavings` | `0.1 W` |

A 128k window gives `111616`, `96000`, `76800` and `12800`. Without `contextWindow` the defaults apply and the footer assumes a 200k window. The limits are recomputed when you switch models, and a value you set in `limits` always wins over the derived one. How compaction uses them is described in [Sessions](sessions.md#compaction).

### extensions

A list of extension files and directories to load, and `builtin:` switches that turn the built-in extensions off and on (`"-builtin:web"`, `"+builtin:web"`). Load order, entry formats and `--no-extensions` are described in [Extensions](extensions.md#where-extensions-load-from).

### extensionConfig

Each extension reads its own section, `extensionConfig.<name>`, as `vela.config`. String values can reference environment variables with `$NAME` or `${NAME}` (an unset variable becomes an empty string; `$$` is a literal `$`). Interpolation applies to `extensionConfig` only, not to other settings.

```json
{
  "extensionConfig": {
    "rag": {
      "embedding": {
        "baseUrl": "https://api.example.com/v1",
        "model": "text-embedding-3-small",
        "apiKey": "${EMBEDDING_KEY}"
      }
    },
    "feishu": { "owners": "ou_xxx,ou_yyy" }
  }
}
```

The CLI fills the built-in extensions' sections from environment variables first (`TAVILY_API_KEY`, `FEISHU_APP_ID`, `EMBEDDING_MODEL_KEY` and the others listed in [CLI](cli.md#environment-variables)); values in `extensionConfig` override them. The keys each built-in extension reads are listed in [Built-in extensions](built-in-extensions.md).

## Data directory

Vela keeps per-project data outside the project, in `~/.vela/projects/`. The directory name is the absolute path of the working folder with the leading separator dropped and `/`, `\` and `:` replaced by `-`, wrapped in `--`, followed by the first 8 hex characters of the path's SHA-256. For `/home/me/code/app`:

```text
~/.vela/
├── settings.json
├── models.json
├── trust.json
├── debug.log                         VELA_DEBUG=1 in interactive mode
├── bin/                              rg / fd downloaded by the CLI
├── extensions/
├── skills/
├── prompts/
├── AGENTS.md                         user-wide instructions (optional)
├── APPEND_SYSTEM.md                  appended to the system prompt (optional)
└── projects/
    └── --home-me-code-app--1a2b3c4d/
        ├── sessions/
        │   ├── <session id>.jsonl    the conversation
        │   └── <session id>/         long tool output and tool call history
        ├── memory/                   memory extension (MEMORY.md and one file per memory)
        ├── usage/today.jsonl         token usage records
        └── rag/knowledge.db          rag extension
```

The hash keeps two folders whose readable names collide (`/a-b/c` and `/a/b-c`) apart. Set `dataDir` to store a project's data somewhere else. Session files are described in [Session format](session-format.md).

## Project trust

A project's `.vela/settings.json`, `.vela/extensions/`, `.vela/prompts/`, `.vela/APPEND_SYSTEM.md` and skills (`.vela/skills/`, `.skills/`, and `.agents/skills/` in the working folder or a parent up to the git root) can change Vela's behavior, run code on your machine or put instructions in front of the model, so Vela loads them only for trusted projects (like pi's project resources). Projects with none of these are not asked about. `AGENTS.md` and `CLAUDE.md` don't count: they load either way (see [Context files](#context-files)).

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

The files are read at startup and are not gated by project trust (same as pi): they are text for the model, which would read them anyway when it reads the project. Treat a folder's instructions as untrusted input even when you decline trust. `--no-context-files` turns them off. Guest sessions (channel senders) never get them. In the SDK, pass `contextFiles` to `createVela()`; see [SDK](sdk.md#createvela-options).

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

The system prompt lists each skill's name, description and the path of its `SKILL.md`, and tells the model to read the file with `read_file` when a task matches. The body is not in the system prompt. Sessions without `read_file` or `bash` (such as guests) get no list. Relative paths in a skill resolve against its directory.

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

Templates load from `<project>/.vela/prompts/` (trusted projects only), the `prompts` setting and `~/.vela/prompts/`, one level deep; the first template with a name wins. Extension commands with the same name run instead of a template. Templates and `/skill:` only expand for the session's owner, like extension commands. The SDK takes template paths through `createVela({ promptTemplateDirs })`.

## Appending to the system prompt

Text in `~/.vela/APPEND_SYSTEM.md`, or in `<project>/.vela/APPEND_SYSTEM.md` when the project is trusted (the project file wins), is added to the system prompt in an `<addendum>` section. `--append-system-prompt <text or file>` (repeatable) replaces both for one run. In the SDK, pass `appendSystemPrompt` to `createVela()`.

## Legacy data

Older versions of Vela wrote data into the working folder: `.sessions/`, `.memory/`, `.usage/` and `knowledge.db`. If Vela finds any of these, it prints a `[data]` notice on stderr with shell commands that move them into the new data directory. Nothing is moved automatically. The commands are safe to run again; run them before creating new sessions or memories in the new directory, since the old data wins on name clashes.
