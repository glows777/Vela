# Settings

Vela reads its configuration from JSON files in the user directory (`~/.vela`, or `VELA_DIR`) and, for trusted projects, from the project's `.vela` directory. This page covers `settings.json`, the data directory, project trust and skills. Model providers live in `models.json`, described in [Models](models.md).

## Files

| File | Scope |
|---|---|
| `~/.vela/settings.json` | User settings, used in every project. |
| `<project>/.vela/settings.json` | Project settings. Read only when the project is [trusted](#project-trust). |
| `~/.vela/models.json` | Model providers. User level only. See [Models](models.md). |
| `~/.vela/trust.json` | Saved project trust decisions. |
| `~/.vela/extensions/` | User extensions, loaded in every project. |
| `<project>/.vela/extensions/` | Project extensions. Loaded only when the project is trusted. |
| `~/.vela/skills/`, `<project>/.vela/skills/`, `<project>/.skills/` | Skills. See [Skills](#skills). |

All files are optional. A file that is not valid JSON, or a key with the wrong type, stops the CLI with a `[config]` error and exit code 2. Unknown top-level keys are ignored; unknown keys under `limits` are an error.

When you start Vela from your home directory, `<project>/.vela` is `~/.vela` itself; it is read once, as user configuration, and no trust question is asked.

## Merge rules

Project settings are applied on top of user settings:

- Objects (`limits`, `extensionConfig`) are merged key by key, recursively.
- `extensions` and `skills` lists are concatenated: user entries first, then project entries.
- Every other value is replaced by the project's value.

Relative paths in `extensions` and `skills` resolve from the directory of the settings file that lists them. `~` expands to the home directory.

## Keys

```json
{
  "defaultModel": "anthropic/<model-id>",
  "defaultThinkingLevel": "medium",
  "dataDir": ".vela-data",
  "limits": { "bashTimeoutMs": 60000 },
  "extensions": ["-builtin:supabase", "./extensions/todo.ts"],
  "skills": ["~/shared-skills"],
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
| `limits` | object | see below | Overrides runtime limits. |
| `extensions` | string[] | `[]` | Extension files or directories, and `builtin:` switches. |
| `skills` | string[] | `[]` | Extra skill directories. |
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
| `bashTimeoutMs` | `10000` | Timeout of the `bash` tool. |

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

A list of extension files and directories to load, and `builtin:` switches that turn the built-in extensions off and on (`"-builtin:supabase"`, `"+builtin:supabase"`). Load order, entry formats and `--no-extensions` are described in [Extensions](extensions.md#where-extensions-load-from).

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

The CLI fills the built-in extensions' sections from environment variables first (`TAVILY_API_KEY`, `SUPABASE_URL`, `FEISHU_APP_ID`, `EMBEDDING_MODEL_KEY` and the others listed in [CLI](cli.md#environment-variables)); values in `extensionConfig` override them. The keys each built-in extension reads are listed in [Built-in extensions](built-in-extensions.md).

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

A project's `.vela/settings.json` and `.vela/extensions/` can change Vela's behavior and run code on your machine, so Vela loads them only for trusted projects. Projects without either are not asked about.

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

Trust does not cover skills: `.skills/` and `.vela/skills/` load in every project. Skills are text, not code, but their descriptions go into the system prompt.

Trust only controls what loads at startup. It does not limit what tools can do afterwards, and it does not make a project's files safe to read; see [Security](security.md#project-trust).

## Skills

A skill is a set of instructions the user activates on demand. Each skill is a directory containing a `SKILL.md`; the directory name is the skill name:

```text
.skills/
└── code-review/
    └── SKILL.md
```

```markdown
---
description: Review the current diff for bugs
when_to_use: Before committing
---
Read the diff with `git diff`, then ...
```

The front matter is optional and supports `description` and `when_to_use`. Skills are loaded from these directories at startup, and a later directory overrides a skill with the same name from an earlier one:

1. `<project>/.skills/`
2. `~/.vela/skills/`
3. the directories listed in the `skills` setting (user, then project)
4. `<project>/.vela/skills/`

The system prompt lists only each skill's name, description and when-to-use hint. The body enters the conversation when you activate the skill:

- `/skill load <name>` adds the body as a user message and marks the skill active.
- `/<name> [instruction]` adds the body (plus your instruction) and runs it immediately.
- `/skill unload <name>` marks it inactive; the body already in the conversation stays.

A body is never added to the same session twice. `/skill` lists the skills and shows which are active. Skills cannot be loaded while a task is running. The SDK takes skill directories through `createVela({ skillDirs })`; see [SDK](sdk.md).

## Legacy data

Older versions of Vela wrote data into the working folder: `.sessions/`, `.memory/`, `.usage/` and `knowledge.db`. If Vela finds any of these, it prints a `[data]` notice on stderr with shell commands that move them into the new data directory. Nothing is moved automatically. The commands are safe to run again; run them before creating new sessions or memories in the new directory, since the old data wins on name clashes.
