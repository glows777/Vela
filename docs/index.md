# Vela documentation

Vela is a self-hosted AI coworker for your team's group chats. You run it on your own machine with the model you choose; Lark ships built in. It is built on a terminal agent and TypeScript SDK. In a group chat it answers short questions, opens a topic for each larger task and keeps that topic's progress up to date. On its own, the same agent takes a task and a working folder, and reads files, runs commands, edits code and searches until the task is done.

## Run Vela in group chats

- [Channels](channels.md): enabling chats, topics, schedules, costs and permissions.
- [Deploy](deploy.md): run `vela serve` under a dedicated user.
- [Security](security.md): what a chat member can make Vela do, and how to limit it.

## Use Vela in your terminal

New to Vela? Follow the [Quickstart](quickstart.md) to install it, connect a model and run your first task.

- [CLI](cli.md): options, run modes, keybindings and slash commands.
- [Models](models.md): built-in providers, `models.json`, thinking levels and the offline demo model.
- [Settings](settings.md): `settings.json`, the data directory, project trust, `AGENTS.md`, skills and prompt templates.
- [Tools](tools.md): the built-in tools the model can call.
- [Sessions and context](sessions.md): continuing sessions, queued messages and compaction.

## Automate or embed Vela

- [JSON mode](json.md) streams the events of one run as JSON lines.
- [RPC mode](rpc.md) controls a long-running Vela process over stdin and stdout.
- The [SDK](sdk.md) runs Vela inside your application, with as many concurrent sessions as you need. Vela is published as six packages; `@glows777/vela` bundles them, and [Packages](sdk.md#packages) says which smaller one to depend on.

## Extend Vela

- [Extensions](extensions.md): add tools, slash commands, model providers and channels, and hook into the agent loop.
- [Built-in extensions](built-in-extensions.md): memory, the RAG knowledge base, web, Lark and MCP.
- [MCP servers](mcp.md): connect Model Context Protocol servers and use their tools.
- [Channels reference](channels-reference.md): writing a channel, the gateway lifecycle, custom transports and external events.
- [Testing](testing.md): test extensions and SDK code offline with the faux model.
- [Session format](session-format.md): the on-disk session file.

Runnable examples are in [examples/](../examples/).

## Work safely

Vela's tools and extensions run with your permissions and there is no sandbox. Read [Security](security.md) before running Vela on untrusted repositories, connecting a channel or leaving it unattended. For a chat bot, [deploy `vela serve`](deploy.md) under a dedicated user.
