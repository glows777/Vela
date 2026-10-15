# Journeys

One row per user-facing feature: how a user reaches it, how to drive it here, and what to check. Expected behavior lives in `docs/` (linked per section). Every row was driven on 2026-10-15. Add a row when you add a feature.

`REPO`, `H`, `RUN` and `VERIFY_MODEL` are as in [SKILL.md](SKILL.md). `faux` means a scenario file passed as `VERIFY_MODEL=faux:/abs/file.json`.

## Tools and the TUI ([tools](../../docs/tools.md), [cli](../../docs/cli.md))

| Feature | Drive | Check |
|---|---|---|
| edit_file | `send "test edit"`, `wait 'Successfully replaced'` | Diff `-1`/`+1`, an `[audit] edit_file → sample-data.txt` line, `grab sample-data.txt` line 1 ends `(updated)` |
| list / read / bash | `list files`, `read a.txt`, `test bash` | `[FILE] a.txt`; the fixture text; `Hello from bash!` |
| Parallel tools | `send "test parallel"`, `wait 'parallel-2'` | `list_directory` and two `bash` calls, no error |
| Interrupt | `send "test loop"`, then `keys Escape` while `Esc to interrupt` shows | `Interrupted`, the editor takes input, `doctor` still OK |
| Steer / queue | During `test loop`: `send "STEER"`; type text then `keys M-Enter` | `Steering:` / `Follow-up:` lines; the steer reaches the model after the current step; Esc puts queued text back in the editor |
| `!cmd` | `send '!echo HI'`, `wait '^ HI'` | `$ echo HI` and its output; `!!cmd` runs without sending |
| Thinking level | `keys BTab` | The footer level changes (`medium` → `high`) |
| Tool selection | `run $RUN t -t read_file -p "read a.txt"`; `-p "list files"` with the same flag | The read works; the list fails because the tool is off |
| grep / find | `test grep`, `test find` | Need `rg` / `fd` on PATH, otherwise a clear "not installed" error |

## Non-interactive modes ([cli](../../docs/cli.md), [json](../../docs/json.md), [rpc](../../docs/rpc.md))

| Feature | Drive | Check |
|---|---|---|
| `-p` | `run $RUN p -p "list files"` | exit 0; stdout is only the answer; stderr only startup notices (`[rag] …`) |
| Piped stdin | `echo ctx \| $H run $RUN --stdin pipe -p "list files"` | Same answer, exit 0 |
| `--mode json` | `run $RUN j --mode json "list files"` | Line 1 `{"type":"session",…}`, then events including `tool_execution_end` |
| RPC | `exec $RUN rpc env VELA_RPC_COMMAND="bun $PWD/src/cli/main.ts" bun $PWD/examples/rpc-client.ts "list files"` | The tool call and answer, exit 0. Closing stdin aborts a running prompt (`agent_end` reason `aborted`) |
| RPC usage error | `run $RUN r --mode rpc hi` | exit 2 with a usage line |
| `--version`, `--help` | `run $RUN v --version` | stdout, exit 0 |

## Sessions ([sessions](../../docs/sessions.md))

| Feature | Drive | Check |
|---|---|---|
| Persist / continue | `run … -p "list files"`, then `run … -c -p "read a.txt"` | One `projects/*/sessions/<id>.jsonl` holding both prompts |
| `--session <id>` | Existing id, then a new id | Appends to it; a new id creates `<id>.jsonl` |
| `--fork <id>` | `run … --fork <id> -p hi` | A second session file; the original is unchanged |
| `--export <id> <out.html>` | `run …` | exit 0, the HTML holds the conversation |
| `--no-session` | `run … --no-session -p "list files"` | No new `<id>.jsonl`, no `tool-history.jsonl`, no `usage/today.jsonl` under `VELA_DIR`. `/status` says `in-memory (not saved)`. |
| `-r` picker | `launch $RUN -r`, `keys Down Enter` | The list shows names, ids, message counts; Enter opens that session |
| `/tree`, `/fork`, `/clone`, `/new`, `/name x` | In the TUI | `/tree` marks `← current`; `/fork` puts the chosen message back in the editor in a new session; `/name` changes the footer |
| `/compact` | Several turns, then `send "/compact"`, `wait 'compacted'` | `[context] Manually compacted …`; too small a session says so |
| Exit | `keys C-d` with an empty editor | `doctor` reports `vela exited`; the session file is complete |

## Commands ([cli](../../docs/cli.md))

| Feature | Drive | Check |
|---|---|---|
| `/status` | `send "/status"`, `wait '\[status\]'` | Session, path (`not written yet` before the first save, `in-memory` with `--no-session`), model, context, usage matching the footer |
| `/usage`, `/cache off` | Two turns, then `/usage` | Input / cache write / cache read / output and a hit rate; `/cache off` stops cache reads |
| `/context` | `send "/context"` | Category breakdown (system prompt, tools, memory, skills, messages) |
| `/hotkeys`, `/hooks`, `/channel`, `/role`, `/extensions` | One each | A block per command; no model call |
| `/model`, `/login` | `send "/model"`; `send "/login"` | Offline `/model` explains there are no models; `/login` lists anthropic / openai / openrouter (Esc to leave) |
| Unknown flags | `run … --thinking huge -p hi`; `run … --model nope/x -p hi` | exit 2 with usage; exit 1 naming the available providers |

## Extensions, project trust, skills ([extensions](../../docs/extensions.md), [settings](../../docs/settings.md))

| Feature | Drive | Check |
|---|---|---|
| Extension tool | faux `hello-tool_greet`; `run … --mode json -e $PWD/examples/extensions/hello-tool.ts "x"` | `tool_execution_end` result `Hello, Liam!` |
| Extension command | `run … -e $PWD/examples/extensions/todo-command.ts -p "/todo buy milk"` | `Added: buy milk` |
| `--no-extensions` | The same faux run with `--no-extensions` | The tool is unavailable; built-ins (memory, web, mcp) are gone |
| Project trust | Put `.vela/extensions/x.ts` or `.skills/<name>/SKILL.md` in `work/` | `-p` skips it with a `[trust]` note on stderr; `--approve` loads it; the TUI asks `(y/N)` |
| Skills | Trusted `.skills/demo/SKILL.md`, then `/skill` and `/skill:demo` | Listed with its description; `/context` counts skill tokens |
| Context files | `AGENTS.md` in `work/` | Not shown anywhere in the CLI; check with an SDK script: `loadConfig({ cwd }).contextFiles` |

## Built-in extensions ([built-in-extensions](../../docs/built-in-extensions.md), [mcp](../../docs/mcp.md))

| Feature | Drive | Check |
|---|---|---|
| MCP | `home/mcp.json` → `{"mcpServers":{"echo":{"command":"bun","args":["$PWD/test/fixtures/mcp-echo-server.ts"]}}}`; faux `tool_search` then `mcp__echo__echo` | `Loaded 1 tool`, then the echoed text |
| memory | faux `memory` with `{"action":"save",…}` | `Saved to memory: …`; the file under `home/projects/*/memory/` |
| web_fetch | Serve a page locally (`python3 -m http.server`), faux `web_fetch` with its URL | The page as Markdown |
| Retry | `-p "test retry"` | `Retry succeeded!` after two 429s |
| Provider error | faux `{"error":"400 Bad Request: …"}` | exit 1, the error on stderr |

## SDK ([sdk](../../docs/sdk.md), [channels](../../docs/channels.md))

| Feature | Drive | Check |
|---|---|---|
| Examples | `exec $RUN ex bun $PWD/examples/sdk/01-minimal.ts` (01–04) | Each exits 0 |
| Your own script | `work/consumer.ts` importing `$REPO/src/index.ts` and `$REPO/src/testing/index.ts`, run with `exec`; recipes in [core.md](core.md) | Whatever the change promises, with its edge cases |
| Channels and guests | `echoChannel({ owners: ['boss'] })` from `examples/extensions/echo-channel.ts`; `receive('stranger', …)` and `receive('boss', …)` | The guest's model sees only `tool_search`; the owner's read works |
| Packaging | `bun run build && bun run smoke:consumer` | Passes in empty Node and Bun projects (needs `fd`) |

## Not reachable offline

Say so in the report instead of counting these as verified: real providers and `/login` OAuth, `web_search` (needs a Tavily or Serper key), RAG (needs an embedding endpoint; the SDK tests use a faux embedder), the Feishu channel (needs app credentials; the SDK echo channel covers the gateway).
