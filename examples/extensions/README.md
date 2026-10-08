# Extension examples

Small extensions, one per API in [docs/extensions.md](../../docs/extensions.md). Run the commands from the repository root. `VELA_MODEL=mock` uses the offline demo model, so no API key is needed, but the demo model doesn't call extension tools; drop it and use a real model to see the model use the extension.

```bash
# Load one extension for this run
VELA_MODEL=mock vela -e examples/extensions/hello-tool.ts

# Or copy it into the user extensions directory to load it every time
cp examples/extensions/hello-tool.ts ~/.vela/extensions/
```

From a source checkout, use `bun src/cli/main.ts` in place of `vela`. Add `--no-extensions` to load only the example and skip the built-in extensions.

| File | Shows | Try it |
|---|---|---|
| [hello-tool.ts](hello-tool.ts) | `registerTool`: a tool the model can call, named `<extension>_greet` (`hello-tool_greet` when loaded from this file) | `VELA_MODEL=mock vela -e examples/extensions/hello-tool.ts`, then (with a real model) ask it to greet someone |
| [todo-command.ts](todo-command.ts) | `registerCommand` and `ctx.ui.notify`: `/todo <text>` adds a todo, `/todo` lists them | `VELA_MODEL=mock vela -p -e examples/extensions/todo-command.ts "/todo buy milk" "/todo"` |
| [prompt-section.ts](prompt-section.ts) | `before_agent_start`: adds today's date as a system prompt section | `VELA_MODEL=mock vela -e examples/extensions/prompt-section.ts`, then (with a real model) ask for the date |
| [confirm-dangerous.ts](confirm-dangerous.ts) | `tool_call` and `ctx.ui.confirm`: asks before a bash command containing `rm`; without a UI (`-p`) the call is blocked | `VELA_MODEL=mock vela -e examples/extensions/confirm-dangerous.ts`, then (with a real model) ask it to delete a file |
| [redact-secrets.ts](redact-secrets.ts) | `tool_result`: masks likely secrets (`sk-...`, `*_KEY=...`) before the model sees a tool result | `VELA_MODEL=mock vela -e examples/extensions/redact-secrets.ts`, then (with a real model) ask it to run `echo API_KEY=abc123` |
| [read-only-session.ts](read-only-session.ts) | `session_start` and `ctx.session.setActiveTools`: sessions whose id starts with `review-` get read-only tools | `VELA_MODEL=mock vela -e examples/extensions/read-only-session.ts --session review-1` |
| [local-provider.ts](local-provider.ts) | `registerProvider` and `vela.config`: adds a `local` provider for an Ollama server; the URL comes from `extensionConfig["local-provider"].baseUrl` | `vela -e examples/extensions/local-provider.ts --model local/qwen3:8b` (needs Ollama running) |
| [echo-channel.ts](echo-channel.ts) | `registerChannel` and `roleFor`: an in-memory channel with one session per conversation and sender; senders are guests unless listed as owners | SDK only (it exports a factory, not a default extension): `createVela({ extensions: [echoChannel({ owners: ['me'] }).extension] })`; see `test/e2e/extensions.test.ts` |

The end-to-end tests in [test/e2e/extensions.test.ts](../../test/e2e/extensions.test.ts) run every example with the scripted faux model.
