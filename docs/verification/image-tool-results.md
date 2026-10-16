# Tool image verification (#61, PR 2)

Tool results now carry canonical text/image content through extension hooks, provider requests and session history. This is the second of three image-input PRs. CLI `@file`, clipboard paste and TUI image placeholders remain PR 3.

## Test-first evidence

The initial Draft contained failing faux scenarios before production changes. Additional provider, file-limit, invalid-image and hook scenarios were written before the corresponding implementation. After correcting a test-only extension tool name mismatch, all **18 initial E2E scenarios failed on unmodified main `2942bf4`**. This clean-baseline replay distinguishes real missing behavior from the naming mistake in the first run.

Independent review found additional regressions; each received a failing E2E before its fix:

- Image-only failed tools lost their image/error information, including nested `ctx.executeTool` calls.
- A long image caption displaced the native structured tool result. Native details and full caption files now remain separate, including accurate failure labels when only the caption was saved.
- Ordinary text beginning with `BM` was mistaken for BMP. Header detection now checks BMP structural fields and preserves both a `BMC` checklist and a two-byte `BM` text file.

The three real AI SDK adapters were inspected and driven with intercepted offline HTTP requests before selecting request conversion. Anthropic and OpenAI Responses accept native image tool parts. OpenAI Chat needs images in a user message after the entire consecutive tool-result group. Failed image results preserve error status as error-text plus a following image message because the AI SDK has no error-content result variant.

## Repeatable checks

From a checkout with Bun 1.4+, Node 22.18+, ripgrep and fd:

```sh
bun install --frozen-lockfile
bun test test/e2e/tool-images.test.ts test/e2e/tool-image-providers.test.ts test/e2e/tool-image-file-limits.test.ts test/e2e/tool-image-order.test.ts
bun run test
bun run typecheck
bun run lint
bun run build
bun run smoke:consumer
```

The final local suite passed **757 tests, 0 failures, 5586 assertions across 92 files**. Typecheck, lint (existing warnings only), build and the packed-package consumer smoke passed. The consumer smoke installs the tarball into empty Node and Bun projects; both printed `tool image sdk ok` after calling the real `read_file` on an oversized image with a misleading extension and forcing Photon from `dist/`.

Independent review passed 100 focused tests and typecheck. Separate practical probes verified all three adapters' failed-image/call-order behavior, interrupted parallel tools followed by resume, native-result recovery and summary safety. No remaining PR 2 blocker was found.

Local runtimes were Node 24.19 and Bun 1.4.0. CI checks the supported Node 22.18 minimum. This cloud host needed the existing Bun/fd paths supplied via an isolated `BASH_ENV` for its login-shell tool-history recipe, and an isolated writable HOME/npm cache for consumer installs. No repository behavior or system software was changed for those environment adjustments.

## Public SDK walkthrough

```sh
H=.skills/verify-vela/scripts/vela-verify.sh
bash "$H" exec tool-images sdk-small bun "$PWD/examples/sdk/06-tool-images.ts"
bash "$H" exec tool-images sdk-wide bun "$PWD/examples/sdk/06-tool-images.ts" "$PWD/test/fixtures/images/wide.png"
bash "$H" cleanup tool-images
```

The example uses `read_file` on `picture.txt` containing image bytes, adds a caption in `tool_result`, switches to a text-only model, then disposes/reopens the session and switches back to vision.

Observed results:

- Small PNG: unchanged, 100 base64 bytes.
- 2600×40 PNG: normalized JPEG, 3172 base64 bytes (core decoder verification: 2000×31).
- The hook caption and image both reached the next request.
- Text-only requests used the tool-image omission placeholder without altering canonical history.
- Resume restored the image for the next vision request.
- Both runs exited 0 and printed `tool hook, text-only fallback and resumed image request verified`.

Evidence was saved by the helper under `/tmp/vela-evidence/issue61-tool-images/` in `sdk-small.*` and `sdk-wide.*`.

## Real CLI JSON walkthrough

```sh
H=.skills/verify-vela/scripts/vela-verify.sh
SCENARIO=$(mktemp)
printf '{"responses":[{"toolCalls":[{"name":"read_file","input":{"path":"%s/test/fixtures/images/wide.png"}}]},{"text":"Image result processed."}]}' "$PWD" > "$SCENARIO"
VERIFY_MODEL="faux:$SCENARIO" bash "$H" run tool-image-cli read-image --mode json --no-extensions 'Read the supplied image'
bash "$H" cleanup tool-image-cli
rm "$SCENARIO"
```

The real CLI process exited 0 and emitted 27 events. Its saved tool message contained one canonical JPEG image with 3172 base64 bytes, rather than raw binary text. Evidence: `/tmp/vela-evidence/issue61-tool-cli/read-image.{cmd,stdout,stderr,exit}`. The checked-in E2Es additionally cover all five header formats, malformed input, source-size limits, real in-memory MCP transport, model switching, hook replacement, caption previews and microcompaction without base64 text files.

## Limits and separately tracked follow-ups

All model replies were faux, and adapter HTTP responses were offline fixtures. These runs prove real SDK/CLI, provider serialization, normalization and persistence behavior; they do not prove live-provider visual recognition. No credentials or live provider calls were used.

The late core custom-message normalization regression is fixed separately in [PR #67](https://github.com/glows777/Vela/pull/67) and should land before this tools PR. Existing core follow-ups remain separate: [transparent-image conversion #68](https://github.com/glows777/Vela/issues/68), [history normalization cost #69](https://github.com/glows777/Vela/issues/69), and [ModelMessage migration documentation #70](https://github.com/glows777/Vela/issues/70). This PR does not claim to resolve those issues or complete the CLI/TUI stage of #61.

## Automatic review corrections

Two P2 findings on the initial complete head were reproduced before correction:

- A `tool_result` hook returning `content: []` made Chat claim an image would follow. One faux and two actual-adapter E2Es failed first; the request now stays honestly empty, including when a preceding tool result lifted an image in the same batch.
- Long-caption previews reordered interleaved images and captions. Two faux E2Es failed for caption-before-image and caption-after-image arrangements. Captions are now previewed in their original position. A further failing many-caption case exposed repeated truncation-notice inflation (9660 text characters versus a 370-character allowance). Compact ellipses count inside the shared text budget; only one recovery note is appended.

The actual public SDK walkthrough saved at `/tmp/vela-evidence/tool-order-pr65-final/sdk.stdout` confirmed request order `[file,text,file,text,text]`, full 1651-character caption recovery through `read_file`, preserved native details, no image base64 in the caption file, and the same image/caption association after resume. Tiny per-caption budgets can show only ellipses; the saved full text remains available. These are offline faux model checks, with real assembly, tools and persistence.

The final independent re-review passed 100 affected/neighboring tests (416 assertions), typecheck, and a real SDK many-caption probe. That probe now emitted 100 preview characters plus one recovery note. No remaining blocking issue was found.

Forge's non-blocking pagination clarification is covered by a further failing-first faux E2E: the model sees an explicit description that `offset`, `limit` and `column` are ignored for images, and a call supplying those parameters still receives the complete image. The 13 targeted file/image tests, typecheck and lint passed. This follow-up changes guidance only, not image or text read behavior.
