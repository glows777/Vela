# Quickstart

Vela runs as a bot in your team's group chats and as an agent in your terminal. This page goes from a fresh install to a bot answering in a Lark group, then covers terminal use, manual provider configuration and running from source.

Vela needs a model: Anthropic, OpenAI (an API key or your ChatGPT plan), OpenRouter, DeepSeek, or any provider you add in `~/.vela/models.json`. Without a key you can try it offline with the built-in demo model. It runs on Node.js 22.18 or newer and on Bun 1.4 or newer.

## 1. Install

Install the `vela` command globally:

```bash
npm install -g @glows777/vela
# or
bun add -g @glows777/vela
```

To run the latest source instead, see [Run from source](#run-from-source).

## 2. Configure a model

Change to the folder you want Vela to work in and start it:

```bash
cd /path/to/project
vela
```

The first run opens the setup wizard in the terminal. It asks, in order:

1. **Choose a provider.** Pick one of the built-in choices:

   ```text
   Choose a provider
     Anthropic API key
     OpenAI API key
     Sign in with ChatGPT
     OpenRouter
     DeepSeek
     Custom provider
   ```

   DeepSeek uses the built-in Responses provider and defaults to `deepseek/deepseek-flash`. For another endpoint, choose `Custom provider`, enter a provider name and base URL, then choose OpenAI Chat Completions, OpenAI Responses or Anthropic Messages. Optional custom headers use a JSON object with string values (for example, `{"x-region":"us"}`); entry is masked. Keep existing headers to skip, or enter `{}` to clear them.

2. **Enter a credential.** The wizard asks for an API key, opens a browser for a ChatGPT or OpenRouter sign-in, or offers to keep a credential it already finds in `auth.json`.

3. **Select Model.** A searchable list shows the models for that provider. Type to filter, use the arrow keys and press Enter. For a custom provider, enter the model ID instead. You can then configure its context window (a positive token count), image input and reasoning support, or keep the existing values/defaults. Escape cancels setup, including in optional inputs.

4. **Verify.** The wizard sends one small request to the provider:

   ```text
   Verification sends a minimal request and may incur a small charge
     Verify
     Cancel
   ```

   If verification fails, the wizard shows the provider's error and offers `Retry verification` or `Cancel and rerun setup`.

5. **Thinking level.** Choose `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, limited to what the model supports.

6. **Connect Lark?** Choose `Not now` to keep the wizard to the model, then follow step 3 below; `Yes, connect Lark` runs the same Lark setup described there.

7. **Save configuration.** The screen lists the model, thinking level and the `auth.json`, `models.json` and `settings.json` locations. `Save configuration` writes the credential and settings; a provider preset also goes to `~/.vela/models.json`.

After saving, Vela opens the terminal UI. Press Ctrl+D on an empty editor to exit before running the next command. Run `vela setup` later to change the model or sign-in. It first shows the current model, thinking level and whether a credential is saved in `auth.json`, and offers `Keep current configuration` or `Change configuration`. For environment variables or a hand-written `models.json`, see [Manual configuration](#manual-configuration).

## 3. Connect a Lark group

Create and publish a Lark custom app first. The [manual Lark reference](channels.md#lark) lists every step: enable the bot, choose long connection, subscribe to `im.message.receive_v1` and `card.action.trigger`, grant the permissions below it, and add the bot to the group. The app console is <https://open.feishu.cn/app>.

Then run, in an interactive terminal:

```bash
vela setup lark
```

The wizard asks, in order:

1. **What the app needs.** A checklist to confirm before it continues:

   ```text
   Create and publish a Lark app, enable its bot, select long connection, subscribe to im.message.receive_v1 and card.action.trigger, grant permissions, and add the bot to the group. Card callback and scopes are not checked by setup. Console: https://open.feishu.cn/app
     Continue
   ```

   Setup checks the app credentials and the long connection only; card callbacks and scopes remain manual.

2. **Credentials.** It asks for the `Lark App ID` and `App Secret`; the secret input is masked. When credentials are already saved in `settings.json`, it first offers `Keep saved credentials` or `Replace credentials`.

3. **Verification.** It connects to Lark with those credentials. On failure it shows the reason and `Check permissions at https://open.feishu.cn/app`, then offers `Retry setup` or `Cancel`.

4. **Mention the bot.** After a successful connection:

   ```text
   Credentials verified. Mention the bot in the group to enable (Ctrl+C twice to cancel).
   ```

   Mention the bot in the group you want it in. Ctrl+C twice cancels setup.

5. **Enable the group.** The wizard names the group and its chat ID and asks for confirmation:

   ```text
   Enable <group> (<chat id>)? Every member of an enabled group has full access to Vela tools.
     Enable group
     Cancel
   ```

   Enabling a group trusts everyone in it with this machine. There is no sandbox or per-member boundary; read [Security](security.md#channel-senders) before enabling a group.

6. **Save.** It writes `extensionConfig.lark` with the app ID, secret and chat ID to `~/.vela/settings.json` (mode `0600`), sends `Vela is connected to this group; run vela serve and @ me.` to the group, and prints a summary that includes any project settings overriding the saved keys.

To add another group later, run `vela setup lark` again and mention the bot there.

## 4. Run the bot

Start the channels:

```bash
vela serve
```

`vela serve` has no terminal UI: it keeps the configured channels running until SIGINT/SIGTERM (Ctrl+C) and writes one line per message, reply and error to stderr, with a local timestamp. If no channel starts, it says so and exits with code 1.

Mention the bot in the enabled group again to check a model-backed reply. The terminal UI does not start channels, so `vela serve` runs separately from `vela`. To keep the bot after the shell closes and after a reboot, follow [Deploy `vela serve`](deploy.md), which installs it under a dedicated user with systemd.

## 5. Use Vela in a terminal

Without `serve`, `vela` opens the interactive UI in your working folder. The screen shows the conversation, an editor, and a footer with the folder, session id, token usage, context percentage, model and thinking level. Type a task and press Enter:

```text
Explain how this repository is structured and how to run its tests.
```

Vela shows each tool call (file reads, searches, edits, shell commands) as it runs. Type `/` to see commands, `/hotkeys` for keyboard shortcuts, and press Ctrl+D on an empty editor to exit. See [CLI](cli.md) for every flag, key and command.

To run one prompt and print only the answer:

```bash
vela -p "Summarize README.md in three bullet points"
git diff | vela -p "Review this change"
```

## Manual configuration

Four providers are built in. Give Vela a key for one of them, and it picks that provider's default model:

| Provider | Variable | Default model |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `anthropic/claude-opus-4-8` |
| `openai` | `OPENAI_API_KEY`, optional `OPENAI_API_BASE_URL` for a proxy | `openai/gpt-5.5` |
| `openrouter` | `OPENROUTER_API_KEY` | `openrouter/moonshotai/kimi-k2.6` |
| `deepseek` | `DEEPSEEK_API_KEY` | `deepseek/deepseek-flash` |

```bash
export ANTHROPIC_API_KEY=sk-ant-...
vela
```

You can also run `/login` inside Vela: it stores an API key, signs in with your ChatGPT Plus/Pro plan (Sign in with ChatGPT, for use on your own machine), or signs in to OpenRouter. See [Credentials and /login](models.md#credentials-and-login).

To use another model, pass `--model provider/id`, pick one with `/model`, or save it as `defaultModel` in `~/.vela/settings.json`:

```json
{ "defaultModel": "anthropic/claude-sonnet-4-6" }
```

Other providers (Ollama, vLLM, a company gateway, an OpenAI-compatible service) go in `~/.vela/models.json`. See [Models](models.md).

The installed `vela` command does not read `.env` files. When you run the source with Bun, Bun loads `.env` from the current folder, so `cp .env.example .env` works for runs started in the clone.

## Run from source

Clone the repository and install its dependencies:

```bash
git clone https://github.com/glows777/Vela
cd Vela
bun install
```

Start it with Bun from the folder you want to work in:

```bash
cd /path/to/project
bun /path/to/Vela/packages/vela/src/cli/main.ts
```

To get a `vela` command from the clone instead, build the package and link it (this runs the compiled `dist/cli/main.js` with Node):

```bash
cd /path/to/Vela
bun run build
npm link
```

`bun run start` in the clone starts Vela with the clone itself as the working folder.

## Try it offline

`VELA_MODEL=mock` replaces the model with a keyword-driven demo model. It needs no key and no network, calls real tools for some requests, and simulates prompt caching so `/usage` and `/context` have something to show:

```bash
VELA_MODEL=mock vela
VELA_MODEL=mock bun packages/vela/src/cli/main.ts     # from a clone
```

Try `hello`, `list files`, `read package.json`, `test bash`, then `/status`, `/usage` and `/context`. `/cache off` turns the cache simulation off so you can compare costs.

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
- [Channels](channels.md): running Vela in a group, topics, schedules, costs and permissions.
- [Channels reference](channels-reference.md): gateway lifecycle, writing a channel and external events.
- [Models](models.md): providers, `models.json`, thinking levels.
- [Settings](settings.md): `settings.json`, project trust, skills.
- [Tools](tools.md): the built-in file, search and shell tools.
- [Built-in extensions](built-in-extensions.md): memory, knowledge base, web, Lark.
- [Extensions](extensions.md): add your own tools, commands, providers and channels.
- [SDK](sdk.md): embed Vela in your own program.
- [Security](security.md): permissions and what Vela does not protect against.

## Uninstall

```bash
npm uninstall -g @glows777/vela
```

This does not remove `~/.vela`. Delete it yourself to remove settings, sessions and memory.
