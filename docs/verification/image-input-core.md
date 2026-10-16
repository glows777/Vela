# Core image input verification (#61, PR 1)

This PR implements core SDK/extension/RPC image input. Tool-returned images and CLI/TUI attachment workflows remain separate PRs. It does not close #61.

## Test-first evidence

On main `e23118c`, the first eight faux E2E scenarios all failed before implementation: request image payload, resize, invalid-image hint, text-only fallback/model switch, resume/fork/clone, input-hook replacement, steer/follow-up attachments, and summary safety. Small fixtures live in `test/fixtures/images/`. Image estimate/RPC tests and 29 normalizer tests were also written before their implementation.

Independent review reproduced two additional regressions. A failing E2E was added before each fix:

- Normalization replaced custom-message objects and lost their display/details metadata. Initial and queued normalization now carries that metadata forward.
- Text-only fallback missed the AI SDK's existing image file/reference forms. Fallback and estimates now recognize these alongside Vela's canonical images, without changing saved history.

## Repeatable checks

From a checkout with Bun 1.4+, Node 22.18+, ripgrep and fd available:

```sh
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run lint
bun run build
bun run smoke:consumer
```

After integrating main `d4c6538` (#60), the full reviewed suite passed **713 tests, 0 failures, 5391 assertions**. An independent integration review passed 71 focused tests and a combined input-hook image/save-failure/reopen walkthrough without blocking findings. Typecheck, lint (existing warnings only), and build passed. Consumer smoke installs a real tarball into empty Node and Bun projects; its image prompt forces Photon WASM initialization and resize from `dist/`, checks the provider's image file part, and type-checks the exported `ImageContent` API.

The cloud host's login shell resets PATH, so its tool-history recipe initially could not find an already-installed Bun (exit 127). Supplying that Bun path through an isolated `BASH_ENV` fixed the environment; the complete suite then passed. The first npm consumer installation also needed a writable isolated HOME/npm cache. Neither workaround changes repository code or installs system software.

## SDK product walkthrough

```sh
H=.skills/verify-vela/scripts/vela-verify.sh
bash "$H" exec image-core-sdk small bun "$PWD/examples/sdk/05-images.ts"
bash "$H" exec image-core-sdk wide bun "$PWD/examples/sdk/05-images.ts" "$PWD/test/fixtures/images/wide.png"
bash "$H" cleanup image-core-sdk
```

Observed through the public SDK:

- Small PNG: `mimeType: image/png`, 100 base64 bytes, unchanged.
- 2600×40 PNG: JPEG, 3172 base64 bytes, resized. Decoder verification measured 2000×31.
- Selecting a model with `input: ['text']` replaced only the request image with the documented placeholder.
- Disposing, reopening, resuming, and selecting the vision model delivered the saved image to the next model request.
- Both scripts exited 0 and printed `resume and vision model request verified`.

## RPC product walkthrough

The real `bun src/cli/main.ts --mode rpc --no-extensions` process was driven under the verification helper's isolated `env -i`, HOME and VELA_DIR, using `VELA_MODEL=faux:<hello scenario>`:

1. A malformed `images: [null]` prompt returned `success: false`.
2. A valid PNG prompt returned started, streamed events, and reached `agent_settled`.
3. `get_messages` returned the inline `{ type: 'image', data, mimeType }` history part.
4. Closing stdin exited 0. The run produced 20 protocol records without an error.

The checked-in RPC E2E reproduces forwarding for `prompt`, `steer` and `follow_up`, plus malformed image recovery:

```sh
bun test test/e2e/rpc.test.ts
```

## Runtime and scope limits

Local source/compiled normalization and consumer runs used Node 24 and Bun 1.4; the repository CI uses Node 22.18 for the supported minimum. Photon decoding, EXIF orientation (all eight values), JPEG80 output, byte/dimension bounds, invalid image recovery, and PNG/JPEG/GIF/WebP/BMP detection were checked with real image data.

All model responses were scripted faux. These checks prove request content, storage, runtime loading and protocol behavior, not a live provider's visual recognition quality. No API keys or real provider requests were used. No system software was installed. No merging or deployment is part of this change.
