# Quickstart

Vela runs in your terminal and works with the files in the folder you start it from. It needs a model: an OpenAI-compatible API, the Anthropic API, or any provider you add in `~/.vela/models.json`. Without a key you can try it offline with the built-in demo model.

Vela runs on Node.js 22.18 or newer and on Bun 1.4 or newer.

## 1. Install

Install the `vela` command globally:

```bash
npm install -g @glows777/vela
# or
bun add -g @glows777/vela
```

To run the latest source instead, clone the repository:

```bash
git clone https://github.com/glows777/Vela
cd Vela
bun install
```

Then start it with Bun from the folder you want to work in:

```bash
cd /path/to/project
bun /path/to/Vela/src/cli/main.ts
```

To get a `vela` command from the clone instead, build the package and link it (this runs the compiled `dist/cli/main.js` with Node):

```bash
cd /path/to/Vela
bun run build
npm link
```

`bun run start` in the clone starts Vela with the clone itself as the working folder.

## 2. Set an API key

The two built-in providers read their keys from environment variables:

| Provider | Variables | Model reference |
|---|---|---|
| `openai` | `OPENAI_API_KEY`, optional `OPENAI_API_BASE_URL` for a proxy or any OpenAI-compatible service | `openai/<model-id>` |
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic/<model-id>` |

Vela has no built-in model list, so you also choose the model id. Either set it once in the environment:

```bash
export OPENAI_API_KEY=sk-...
export OPENAI_API_MODEL_NAME=<model-id>   # used as openai/<model-id>
```

or pass it on the command line, or save it as `defaultModel` in `~/.vela/settings.json`:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
vela --model anthropic/<model-id>
```

```json
{ "defaultModel": "anthropic/<model-id>" }
```

Other providers (OpenRouter, Ollama, vLLM, a company gateway) go in `~/.vela/models.json`. See [Models](models.md).

The installed `vela` command does not read `.env` files. When you run the source with Bun, Bun loads `.env` from the current folder, so `cp .env.example .env` works for runs started in the clone.

## 3. First run

Change to the folder you want Vela to work in and start it:

```bash
cd /path/to/project
vela
```

The terminal UI shows the conversation, an editor, and a footer with the folder, session id, token usage, context percentage, model and thinking level. Type a task and press Enter:

```text
Explain how this repository is structured and how to run its tests.
```

Vela shows each tool call (file reads, searches, edits, shell commands) as it runs. Type `/` to see commands, `/hotkeys` for keyboard shortcuts, and press Ctrl+D on an empty editor to exit. See [CLI](cli.md) for every flag, key and command.

To run one prompt and print only the answer:

```bash
vela -p "Summarize README.md in three bullet points"
git diff | vela -p "Review this change"
```

## Try it offline

`VELA_MODEL=mock` replaces the model with a keyword-driven demo model. It needs no key and no network, calls real tools for some requests, and simulates prompt caching so `/usage` and `/context` have something to show:

```bash
VELA_MODEL=mock vela
VELA_MODEL=mock bun src/cli/main.ts     # from a clone
```

Try `hello`, `list files`, `read package.json`, `test bash`, then `/usage` and `/context`. `/cache off` turns the cache simulation off so you can compare costs.

## Where things are stored

Everything lives under `~/.vela` (set `VELA_DIR` to use another directory): `settings.json`, `models.json`, `trust.json`, user `extensions/`, `skills/` and `prompts/` and an optional `AGENTS.md` at the top, and one data directory per project folder under `projects/`, holding its sessions, memory, usage records and knowledge base. The full layout is in [Settings](settings.md#data-directory).

Vela never writes into the project folder itself. A project can add its own `.vela/settings.json`, `.vela/extensions/`, prompt templates and skills (`.vela/skills/`, `.agents/skills/`, `.skills/`), which load only after you trust the project. `AGENTS.md` or `CLAUDE.md` in the project is put into the system prompt either way, like pi. See [Project trust](settings.md#project-trust).

## Continue later

Each launch starts a new session, and sessions are saved automatically. Continue the most recent session for this folder with:

```bash
vela -c
```

`vela -r` or `/resume` picks from saved sessions. See [Sessions](sessions.md).

## Next steps

- [CLI](cli.md): flags, run modes, keys and slash commands.
- [Models](models.md): providers, `models.json`, thinking levels.
- [Settings](settings.md): `settings.json`, project trust, skills.
- [Tools](tools.md): the built-in file, search and shell tools.
- [Built-in extensions](built-in-extensions.md): memory, knowledge base, web, Feishu.
- [Extensions](extensions.md): add your own tools, commands, providers and channels.
- [SDK](sdk.md): embed Vela in your own program.
- [Security](security.md): roles, permissions and what Vela does not protect against.

## Uninstall

```bash
npm uninstall -g @glows777/vela
```

This does not remove `~/.vela`. Delete it yourself to remove settings, sessions and memory.
