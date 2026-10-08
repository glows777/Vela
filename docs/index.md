# Vela documentation

Vela is an AI agent that works from your terminal and a TypeScript SDK for embedding the same agent in your own app. Give it a task and a working folder, and it reads files, runs commands, edits code and searches until the task is done.

## Start using Vela

New to Vela? Follow the [Quickstart](quickstart.md) to install it, connect a model and run your first task.

- [CLI](cli.md): options, run modes, keybindings and slash commands.
- [Models](models.md): built-in providers, `models.json`, thinking levels and the offline demo model.
- [Settings](settings.md): `settings.json`, the data directory, project trust and skills.
- [Tools](tools.md): the built-in tools the model can call.
- [Sessions and context](sessions.md): continuing sessions, queued messages and compaction.

## Automate or embed Vela

- [JSON mode](json.md) streams the events of one run as JSON lines.
- [RPC mode](rpc.md) controls a long-running Vela process over stdin and stdout.
- The [SDK](sdk.md) runs Vela inside your application, with as many concurrent sessions as you need.

## Extend Vela

- [Extensions](extensions.md): add tools, slash commands, model providers and channels, and hook into the agent loop.
- [Built-in extensions](built-in-extensions.md): memory, the RAG knowledge base, web, Supabase and Feishu.
- [Channels](channels.md): connect chat apps, with one session per conversation.
- [Testing](testing.md): test extensions and SDK code offline with the faux model.
- [Session format](session-format.md): the on-disk session file.

Runnable examples are in [examples/](../examples/).

## Work safely

Vela's tools and extensions run with your permissions and there is no sandbox. Read [Security](security.md) before running Vela on untrusted repositories, connecting a channel or leaving it unattended.
