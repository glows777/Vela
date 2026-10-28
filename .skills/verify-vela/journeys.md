# Journeys

One row per user-facing feature: how a user reaches it, how to drive it here, and what to check. Expected behavior lives in `docs/` (linked per section). Rows were driven when they were added (the first set on 2026-10-15; the Feishu topic, group and routine rows on 2026-10-19). Add a row when you add a feature.

`REPO`, `H`, `RUN` and `VERIFY_MODEL` are as in [SKILL.md](SKILL.md). `faux` means a scenario file passed as `VERIFY_MODEL=faux:/abs/file.json`.

## Tools and the TUI ([tools](../../docs/tools.md), [cli](../../docs/cli.md))

| Feature | Drive | Check |
|---|---|---|
| edit_file | `send "test edit"`, `wait 'Successfully replaced'` | Diff `-1`/`+1`, an `[audit] edit_file → sample-data.txt` line, `grab sample-data.txt` line 1 ends `(updated)` |
| list / read / bash | `list files`, `read a.txt`, `test bash` | `[FILE] a.txt`; the fixture text; `Hello from bash!` |
| Parallel tools | `send "test parallel"`, `wait 'parallel-2'` | `list_directory` and two `bash` calls, no error |
| Interrupt | `send "test loop"`, then `keys Escape` while `Esc to interrupt` shows | `Interrupted`, the editor takes input, `doctor` still OK |
| Steer / queue | During `test loop`: `send "STEER"`; type text then `keys M-Enter` | `Steering:` / `Follow-up:` lines. `wait` does not return while `Esc to interrupt` is showing, so snap during the run. The steer reaches the model after the current step. Esc puts queued text back in the editor |
| `!cmd` | `send '!echo HI'`, `wait '^ HI'` | `$ echo HI` and its output; `!!cmd` runs without sending |
| Thinking level | `keys BTab` | The footer level changes (`medium` → `high`) |
| Tool selection | `run $RUN t -t read_file -p "read a.txt"`; `-p "list files"` with the same flag | The read works; the list fails because the tool is off |
| grep / find | `test grep`, `test find` | With `rg` and `fd` on PATH, `test grep` searches `src` and the seeded work directory reports that path was not found. `test find` reports no matches. Without those binaries, `VELA_OFFLINE=1` makes the tool say they are not installed |
| CLI image / text attachments | `run $RUN image --mode json @/abs/shot.png "Describe this"`; repeat with `@~/shot.png`, screenshot narrow-space names, two images, BOM/empty text, a slash command, image-only input, and a missing path | Image content by header (also with a misleading extension). A PNG whose longest side is over 2000px is delivered as JPEG. A small PNG stays `image/png`. Escaped absolute filename references in attachment order, BOM stripped and empty text skipped, attachments on the first prompt only. Slash commands show an ignored-attachment notice. A missing file exits 1 before a model request |
| TUI clipboard image / text | Copy a fixture image to an isolated system clipboard, `launch $RUN`, type a request, `keys $RUN C-v` (Windows: Alt+V), wait for the inserted path, then submit; faux model calls `read_file`. Repeat with multiline clipboard text and delayed reads | Private temp file contains the image, request carries tool image content, history shows `[image …]` without base64; text fallback inserts at the cursor without submitting; Enter/Alt+Enter remain independent of a pending read; ordinary bracketed text paste works; temp file removed on exit. Report mocked clipboard separately when a system clipboard is unavailable |
| TUI image history | `launch $RUN @/abs/shot.png "Describe this"`, then quit and `launch $RUN -c` | Initial and resumed user history shows a short image placeholder, including image-only prompts; tool images also use placeholders; no base64 on screen |

## Non-interactive modes ([cli](../../docs/cli.md), [json](../../docs/json.md), [rpc](../../docs/rpc.md))

| Feature | Drive | Check |
|---|---|---|
| `-p` | `run $RUN p -p "list files"` | exit 0; stdout is only the answer; empty stderr with no optional services configured |
| Piped stdin | `echo ctx \| $H run $RUN --stdin pipe -p "list files"` | Same answer, exit 0 |
| `--mode json` | `run $RUN j --mode json "list files"` | Line 1 `{"type":"session",…}`, then events including `tool_execution_end` |
| RPC | `exec $RUN rpc env VELA_RPC_COMMAND="bun $PWD/packages/vela/src/cli/main.ts" bun $PWD/examples/rpc-client.ts "list files"` | The tool call and answer, exit 0. Closing stdin aborts a running prompt (`agent_end` reason `aborted`) |
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
| `/hotkeys`, `/hooks`, `/channel`, `/extensions` | One each | A block per command; no model call |
| `/model`, `/login` | `send "/model"`; `send "/login"` | Offline `/model` explains there are no models; `/login` lists anthropic / openai / openrouter (Esc to leave) |
| Unknown flags | `run … --thinking huge -p hi`; `run … --model nope/x -p hi` | exit 2 with usage; exit 1 naming the available providers |

## Extensions, project trust, skills ([extensions](../../docs/extensions.md), [settings](../../docs/settings.md))

| Feature | Drive | Check |
|---|---|---|
| Extension tool | faux `hello-tool_greet`; `run … --mode json -e $PWD/examples/extensions/hello-tool.ts "x"` | `tool_execution_end` result `Hello, Liam!` |
| Extension command | `run … -e $PWD/examples/extensions/todo-command.ts -p "/todo buy milk"` | `Added: buy milk` |
| `--no-extensions` | The greet faux with `--mode json --no-extensions` and no `-e` | The tool is unavailable and the available-tools list has no built-ins. `-e` still loads beside this flag, so the hello-tool run is the wrong check |
| Project trust | Put `.vela/extensions/x.ts` or `.skills/<name>/SKILL.md` in `work/` | `-p` skips it with a `[trust]` note on stderr; `--approve` loads it; the TUI asks `(y/N)` |
| Skills | Trusted `.skills/demo/SKILL.md`, then `/skill` and `/skill:demo` | Listed with its description; `/context` counts skill tokens |
| Context files | `AGENTS.md` in `work/` and `home/AGENTS.md` | Startup shows `[context]` with `AGENTS.md` and `$VELA_DIR/AGENTS.md`. `/status` lists the same paths after `Context files:`. `--no-context-files` shows neither. |

## Built-in extensions ([built-in-extensions](../../docs/built-in-extensions.md), [mcp](../../docs/mcp.md))

| Feature | Drive | Check |
|---|---|---|
| MCP | `home/mcp.json` → `{"mcpServers":{"echo":{"command":"bun","args":["$PWD/test/fixtures/mcp-echo-server.ts"]}}}`; faux `tool_search` then `mcp__echo__echo` | `Loaded 1 tool`, then the echoed text |
| Unconfigured RAG | `run $RUN p -p "hello"`; in the TUI, `/extensions` then `/rag` | Ordinary startup is quiet; the listing includes `/rag`; `/rag` explains missing settings without a model call or database |
| memory | faux `memory` with `{"action":"save",…}`, then a second prompt in that `--mode json` run | `Saved to memory: …` and the file under `home/projects/*/memory/`. The second prompt's `message_start` events are the user text, then `custom.customType` `memory` with `display` false. That index is now the last user message |
| web_fetch | Serve a page locally (`python3 -m http.server`), faux `web_fetch` with its URL | The page as Markdown |
| Retry | `-p "test retry"` | `Retry succeeded!` after two 429s |
| Provider error | faux `{"error":"400 Bad Request: …"}` | exit 1, the error on stderr |

## SDK ([sdk](../../docs/sdk.md), [channels](../../docs/channels.md))

| Feature | Drive | Check |
|---|---|---|
| Examples | `exec $RUN ex bun $PWD/examples/sdk/01-minimal.ts` (01–04) | Each exits 0 |
| Your own script | `work/consumer.ts` importing `$REPO/packages/vela/src/index.ts` and `$REPO/packages/vela/src/testing/index.ts`, run with `exec`; recipes in [core.md](core.md) | Whatever the change promises, with its edge cases |
| Channels | `echoChannel()` from `examples/extensions/echo-channel.ts`: one shared session per chat. `receive('alice', …)` and `receive('bob', …)` | Both senders use the same session and can read a file |
| Feishu channel journeys | `exec $RUN feishu bun $REPO/.skills/verify-vela/scripts/feishu-journeys.ts` (up to about 2 minutes, exits 1 if a check fails; see [the script](scripts/feishu-journeys.ts)). It drives the real extension and gateway with `fakeFeishu()` / `feishuEvent()` from `test/support/feishu.ts` and a router faux model; adapt it for the change you made | Below, one row per journey; the script prints one line per check |
| Feishu topic handoff | Top-level @ "investigate …": the channel session calls `feishu_start_topic`; the topic session does the work | One topic opened; `OnIt` replaced by `DONE`; one progress card created and patched; the topic result @-mentions the requester |
| Feishu topic replies without @ | Another member replies in the topic without mentioning the bot | The topic session answers and @-mentions that member; no new topic |
| Feishu group workspace | The topic task writes a file | The file lands in `<dataDir>/channels/feishu-<chat>/workspace/`, not in the Vela cwd |
| Feishu untagged top-level chatter | Unmentioned group message ("lunch at 12?") with the default `readUntagged`. The script then sends a passive message the model answers in text | `feishu_skip_reply` sends nothing. Text after that tool can add `OnIt`, and the silent finish removes it with no `DONE`. A text answer that is sent gets `OnIt`, then `DONE` |
| Feishu topic overview | Top-level @ "list topics" | `feishu_list_topics` returns the topic with requester and state from the durable directory |
| Feishu routines | In the topic: @ "remind me in a minute" (`feishu_routines` create with a deployment-local `at`), then `!routines` without @; dispose before the due time, wait past it, start a new Vela on the same dataDir | Create returns the timezone and next local run; `!routines` lists it with zero model calls; after restart the reminder arrives once in the topic, @-mentions the creator, the model input says `late by …`, and `routines.json` no longer holds the one-off |
| Feishu attachments | SDK with the Feishu extension and fake resource streams: deliver a DM image, a group image followed by @text, a file, traversal filename, a file above 20MB and audio | Image request data, four-image history bound, actual saved file and its absolute path, directory containment, too-large and unsupported replies. Feishu transport and provider remain fake |
| Feishu restart recovery | Isolated SDK/faux process with fake Feishu transport: save a topic input, SIGKILL only that subprocess, then start a second process on its dataDir; also kill during preparation and after answer save | Continuation notice then answer/Stop card; unsaved input asks for resend with no model call; saved final answer is delivered; list/forward retains topic identity; no writes for unowned untagged topics. Real Feishu service remains unverified |
| Feishu topic commands | Isolated SDK/faux with fake Feishu: send `!stop` and `!restart` with/without mentions; restart an active and idle topic; send the next input without a mention; repeat after reopening the same dataDir | Stop retains history; Restart archives the old ID without an automatic model call; next input uses a new ID and full topic history; stale Stop cannot affect it; current controls still work; no writes for unowned unmentioned commands |
| Feishu topic status | Isolated SDK/faux with scripted usage in two topics and another group, plus a summary; query `!status` with/without mentions while active and idle; reopen the same dataDir and use `!restart` | Status makes no model call or steer/stop; model/context and exact topic/group totals are visible; ledger only appends and totals survive restart/generation changes; unpriced requests and coverage limits are explicit |
| Feishu run controls | SDK `createVela({ model: faux, extensions: [feishu({ chats, owners, transport: fake })] })`; start channels, hold a tool, deliver a second @, then deliver real-shaped `card.action.trigger` bodies through the captured transport handler | Card arrives during the tool; no click / Queue keeps ordered answers; Steer sends one combined reply with both names; Stop confirms and cancels pending steers without losing default-queued messages; wrong-chat, non-owner-DM, repeated and stale callbacks do nothing; saved history survives restart. Only the Feishu transport and model are fake |
| SDK / RPC image input | SDK `prompt(text, { images })`; RPC `prompt`, `steer`, `follow_up` with the same `images` array; use `test/fixtures/images/wide.png` for resize | Provider gets image content; normalized inline history persists; malformed RPC images reject clearly; non-vision fallback changes only the request |
| Tool images / provider transport | SDK `06-tool-images.ts` with wide.png; CLI `--mode json` with faux read_file scenario; offline real-provider request captures | read_file and MCP reach model as images; native Anthropic/Responses tool blocks, Chat images after all tool results; history survives resume and keeps native details |
| Packaging | `bun run build && bun run smoke:consumer` | Passes in empty Node and Bun projects (needs `fd`) |

## Not reachable offline

Say so in the report instead of counting these as verified: real providers and `/login` OAuth, `web_search` (needs a Tavily or Serper key), RAG (needs an embedding endpoint; the SDK tests use a faux embedder), and live Feishu permissions, callback delivery, card rendering, mention notifications and on-time routine delivery in the deployment timezone (need app credentials and a running deployment). The SDK can drive the actual Feishu extension and gateway offline with a fake transport; that does not verify Feishu's service.
