# Agent lessons

After a miss is confirmed, write a lesson. Record the trigger path, the layer that should have caught it, and the mechanism patch. The layer is pre-PR, AI/bot review, CI, human, or post-merge. The patch is a line in [REVIEW.md](REVIEW.md), a lint, or a verify-vela journey. A lesson with no mechanism change is not closed.

## Agent runtime changes must account for prompt cache

[Issue #442](https://github.com/glows777/Vela/issues/442) identified two ways a shared channel session could lose its cached prefix: a checkout changed the Git branch embedded in `<env>`, and switching between direct, passive and handoff inputs changed a channel system-prompt section. On the next request, the changed prefix could force the provider to process a long conversation again. Frequent channel wakes made the cost visible; neither every wake nor every provider necessarily misses cache. This was a post-merge observation that runtime design and pre-PR review should have caught.

For Agent runtime designs, assess the full request prefix and ordering, not just whether the text is correct. Stable instructions should remain stable. Per-input classification belongs with the input rather than dynamically rewriting system instructions; do not inject Git branch automatically, and query it in the selected execution environment when needed. A necessary prefix change, such as loading a tool, may still be the right trade-off when documented. Cache keys, breakpoints, minimum sizes, expiration and billing depend on the provider, so compare consecutive request shapes and cache-read/write usage rather than assuming a universal cache guarantee.

The prevention mechanism is the Agent runtime prompt-cache review check in [REVIEW.md](REVIEW.md). [#444](https://github.com/glows777/Vela/pull/444) addresses branch injection, and [#445](https://github.com/glows777/Vela/issues/445) tracks wake-kind handling; their fixes and verification remain subject to review. A faux cache scenario can guard prefix stability, but it does not prove a real-provider hit or savings.

## Background memory work must respect tool availability and atomic merges

[PR #307's review](https://github.com/glows777/Vela/pull/307#discussion_r4504727382) found that a deny-only background gate let `memory: ask` sessions consolidate without approval. The pre-PR tests covered `deny`, but not the approval-required path or an already-due shared inbox. That fix required `allow` for collection and both automatic and manual runs. Since [#348](https://github.com/glows777/Vela/issues/348) removed the permission API, dream follows the memory tool's availability: a session with `tools: ['-memory']` neither collects nor consolidates. User extensions handle confirmation for ordinary tool calls.

The [same review](https://github.com/glows777/Vela/pull/307#discussion_r4504727383) found that independently skipping a changed merge destination still deleted its source. The pre-PR single-note race did not cover dependent operations. Dream now checks every full note supplied to the model plus create targets before applying any operation and retains the whole inbox on conflict. This includes a duplicate destination that the model reads but does not update; a live edit to that note must still prevent deletion of its source. Faux cases reproduce both operation orders and a create collision; the memory SDK journey in [verify-vela](.skills/verify-vela/journeys.md) covers tool exclusion, a description-only live edit, retained evidence and a successful refreshed retry. AI/bot review caught both misses; these entry-path scenarios are the verification mechanism.

The next Leader review found retained failed/skipped inboxes were immediately due again, causing a full model call on every later turn. Pre-PR checks covered a single failure and manual recovery, not automatic follow-up traffic. Automatic retry now counts newly collected turns independently of inbox truncation and uses the last run time for the 24-hour threshold; `/memory` exposes failed/skipped outcomes. The retry cadence faux scenarios and [SDK journey](.skills/verify-vela/journeys.md) are the mechanism, with one code-fence unwrap at the model response boundary and unchanged strict operation validation.

## Check the account that performs GitHub setup

In [PR #298](https://github.com/glows777/Vela/pull/298#discussion_r4501042665), an expired inactive GitHub CLI account made setup choose manual fallback and print the webhook secret even when the active account could manage hooks. The pre-PR fixture modeled only one authentication result, so it missed `gh auth status` checking every saved account.

The fixture now follows the upstream active/inactive account behavior. Real CLI regressions and the packed setup journey fail before the fix and verify automatic creation/update without secret output after it. Invalid active credentials retain manual fallback. Setup uses `--active` and documents GitHub CLI 2.57 or newer; the installed older CLI's help is evidence of compatibility limits, not a live authentication test.

## A disappearing diagnostic does not prove a fix

### Incident

In [issue #137](https://github.com/glows777/Vela/issues/137), Knip misidentified `smoke.ts`, generated and run inside temporary consumer projects, as an unlisted binary. [PR #136](https://github.com/glows777/Vela/pull/136) had already introduced the narrow `ignoreBinaries: ["smoke.ts"]` exception, independently verified and explicitly approved by Liam before merge. Vela proposed constant interpolation solely to make the command argument non-static and remove the exception. This was a proposal, not a merged implementation. The approved reasoning is recorded in [comment 6286702252](https://github.com/glows777/Vela/issues/137#issuecomment-6286702252).

### Cause

The reasoning optimized checker output instead of actual behavior or analysis correctness. Making an argument opaque to Knip could hide the report without improving its understanding; an empty ignore list would not prove the underlying problem was fixed.

### Correction

Reproduce the finding and classify it as a real defect or a false positive. A transparent, minimal, supported configuration exception can be a complete project fix. Keep the verified exception here; pursue upstream recognition improvements only when justified by a minimal reproduction and evidence that existing configuration is insufficient. Constants and suppressions are not categorically wrong: judge their independent purpose, scope and evidence.

### Check before fixing

- Identify what is actually wrong and what evidence would demonstrate a correction.
- Check whether the change improves behavior or analysis correctness, or merely prevents detection.
- Preserve other diagnostics; verify actual behavior, including `bun run smoke:consumer` for any replacement in this case, before claiming success.

## An announcement failure must not inherit a human reply target

Forge reproduced [PR #235's failed external-event announcement](https://github.com/glows777/Vela/pull/235#issuecomment-6464240647): the new group message could not be sent, but the generic error path replied beneath the previous human message. The pre-PR happy-path test and diff self-review missed the asymmetric transport failure; CI stayed green because it never rejected only the announcement.

The adapter now treats that rejection as failed preparation: diagnose and skip, without a model call or fallback reply. The mechanism is the source faux regression plus the event SDK verify-vela journey, both rejecting announcement send while leaving reply available and asserting no human-message reply. The packed Lark consumer repeats the boundary on Node and Bun. This preserves ordinary feedback errors instead of globally suppressing them.

The [follow-up review](https://github.com/glows777/Vela/pull/235#issuecomment-6465110866) reached the same failure class earlier, when directory admission could not write its index. External top-level inputs must not borrow a prior human reply ID at construction, and their shared feedback-error path records diagnostics without synthesizing a message. Admission-write failure now joins announcement failure in the source, SDK journey and packed consumer checks, with a human-input control preserving its own error reply.

## Do not sample a shared faux call log by position

[Issue #243](https://github.com/glows777/Vela/issues/243). The silent topic-to-group-to-topic case in `test/e2e/channel-handoff.test.ts` asserted `t.model.calls.at(-1)?.lastUserText` was the hop note to topic B. Lark still showed B's answer, and the offline handoff journey passed. The assertion failed when the group session started another turn after B's hop turn.

`createFauxModel` appends a call when the request starts. `lastUserText` is the last user message, so a follow-up after `channel_message_topic` and `lark_skip_reply` still carries the topic's earlier note. That follow-up can be `at(-1)` while the hop note is already in the array.

AI/bot review should have caught it. The case now finds the hop with `lastUserText`. The mechanism is the channel end-to-end item in [REVIEW.md](REVIEW.md). Do not assert `model.calls.at(-1)` across concurrent channel sessions. Run `bun test test/e2e/channel-handoff.test.ts` before merging a handoff change.

## A channel change updates the channels guide

[Issue #244](https://github.com/glows777/Vela/issues/244). PR #242 shipped the hand-off tools, status lines and topic start context but updated only `CHANGELOG.md` and the verify-vela journeys, so `docs/channels.md` kept the pre-handoff dispatch story until a separate issue. Behavior that a person or a model can see needs the docs pages that describe it, in the same pull request as the changelog entry. The mechanism is the docs item in [REVIEW.md](REVIEW.md) and the Docs section of the pull request template.

## A first-run wizard hides the recovery hint it replaces

[Issue #279](https://github.com/glows777/Vela/issues/279). A first run without a model rendered the header's `/model` hint and the `[model] No model available…` diagnostic before the setup wizard opened, so the screen told the user to do what the wizard was already doing, and both strings stayed in the transcript afterwards.

Model guidance belongs to a state the wizard is about to leave: while the startup wizard runs, it owns those messages, and a cancelled setup brings the hint back. The mechanism is the prefix assertion in `test/e2e/cli.test.ts` (no hint or diagnostic before `Choose a provider`) and the in-process TUI case that checks the hint returns after cancel; both fail without the quiet startup open.

## SDK warnings in interactive mode belong in the chat log

[Issue #337](https://github.com/glows777/Vela/issues/337). After [#335](https://github.com/glows777/Vela/pull/335) upgraded the AI SDK, an MCP record tool with a `propertyNames` schema made the OpenAI-compatible adapter report a compatibility warning. The SDK writes warnings through `process.emitWarning`, not `console.*`, so the TUI's console capture missed them: stderr painted over the screen on every request. The pre-PR tests covered the request payload and the returned warning, not where the warning was displayed.

Interactive mode now installs `globalThis.AI_SDK_LOG_WARNINGS` for its lifetime, shows each formatted warning once, and restores the previous value on shutdown. The layer was human review: #334 named this display follow-up but closed without an issue for it. The mechanism is the TUI case in `test/e2e/tui-sdk-warnings.test.ts`, which drives the real OpenAI Responses adapter and a `propertyNames` tool, and the SDK warning journey in [verify-vela](.skills/verify-vela/journeys.md) that repeats it through the real CLI.

## A persisted session channel is routing identity after resume

[Issue #354](https://github.com/glows777/Vela/issues/354). After [#349](https://github.com/glows777/Vela/pull/349), `listSessions()` reads a channel from the session header or the last `session_channel` entry, but `resume()` left `session.channel` empty. A later `vela.session(id, { channel })` for a different channel was treated as the first binding. The next prompt appended `session_channel`, and the summary took that later entry. Opening with the other channel before `resume()` did not append, and `session.channel` still disagreed with the summary.

AI/bot review of #349 should have caught it. The review covered the first late binding and archive writes, not a different bind after the channel was already saved. The mechanism is the resume cases in `test/e2e/sessions.test.ts` and the session-channel item in [REVIEW.md](REVIEW.md). A change to session channel persistence must re-check that conflict after resume.

## A new public Vela method belongs in the SDK member table

[Issue #359](https://github.com/glows777/Vela/issues/359). [#352](https://github.com/glows777/Vela/pull/352) added `channel(name)` on `ChannelVela` and the umbrella `Vela`. The channels reference, the changelog and the public API snapshot included the method. The Vela member table in `docs/sdk.md` omitted `channel(name)`. The host-lifecycle note on that page omitted it too. The Channels reference lines in `docs/index.md` and `docs/channels.md` described writing a channel, the gateway, transports and events.

AI/bot review of #352 checked the channels reference and missed the SDK inventory of the same object. A new public method on `ChannelVela` or the umbrella `Vela` must have a row in that table, or the page must record the decision to leave the method out. The mechanism is the SDK member-table item in [REVIEW.md](REVIEW.md).

## An Issue-feed allowlist change updates the webhook journey

[Issue #358](https://github.com/glows777/Vela/issues/358). [#357](https://github.com/glows777/Vela/pull/357) made `issueLabels` a strict allowlist. An empty list, including an omitted option, accepts no Issue event. The product tests and the channel docs moved with that change. `.skills/verify-vela/scripts/webhook-journeys.ts` still posted an unlabeled `issues` `opened` against an omitted list and expected a model turn. The signed delivery returned HTTP 202, and the journey then failed because the call count stayed at 6 instead of 7.

Pre-PR review should have caught it. CI does not run the verify-vela journeys, so the stale script reached main. A breaking change to GitHub Issue-feed gating has to update that webhook journey in the same pull request, including the empty default. The mechanism is the journey. It fails if an empty list delivers every Issue again. The Issue-feed item in [REVIEW.md](REVIEW.md) is the review check.

## A captured JSON event has to come from a fresh run

[Issue #347](https://github.com/glows777/Vela/issues/347). [PR #344](https://github.com/glows777/Vela/pull/344) updated the JSON mode example so the mock model calls `bash` with `ls`, but the streamed `toolcall_delta` on that line stayed `{"path":"."}` from `list_directory`. The edit renamed `toolName`, `input`, and `result` in an old capture and left the nested `assistantMessageEvent.delta` alone. Pre-PR review missed it because nothing compared that delta with a new `vela --mode json` run.

When refreshing a captured CLI/JSON fixture, the whole event (including nested `assistantMessageEvent.delta`) has to come from a fresh run, not from renaming fields in an old capture. The mechanism is `test/unit/json-example.test.ts`. It fails when a `toolcall_delta` in the `docs/json.md` session example is not part of the tool input on the same line.

## A public session field updates the format contract

[Issue #434](https://github.com/glows777/Vela/issues/434). [PR #425](https://github.com/glows777/Vela/pull/425) added `location` to `SessionHeader`, wrote `{ environment: 'local', cwd }` on new transcripts and `exportJsonl()`, and described resume in `docs/sdk.md` and `CHANGELOG.md`. `docs/session-format.md` still omitted `location` from the Header example. Pre-PR review checked the SDK page, the changelog, and end-to-end tests, and did not compare the format contract with the new header field.

When a public session header or entry field is added, or the written transcript shape changes, update `docs/session-format.md` in the same change. The mechanism is `test/unit/session-format.test.ts`. It fails when the Header example omits `location` or its fields drift from `SessionHeader` in `packages/core/src/session/entries.ts`. The contract facts are separate anchors, so a reword that still states them keeps the test green.

## The prompt intro must not name capabilities the session lacks

[Issue #406](https://github.com/glows777/Vela/issues/406). [#379](https://github.com/glows777/Vela/pull/379) made `<tools>` and `<rules>` render from the session's active tools, so a session narrowed to `read_file` no longer sees `bash`, `write_file` or `edit_file` there. The intro paragraph above them stayed the fixed sentence claiming the agent works by "reading, searching and editing files, running commands", so `--tools read_file`, an SDK `tools` list and a chat's `tools` list all read a contradiction in the first line. The section tests of #379 checked each section on its own and never compared the prompt's first paragraph with the tools it described.

Pre-PR review and AI/bot review should have caught it: the new capability text and the new renderer landed in the same change. Capability words belong to the tool (`promptSnippet` / `promptGuidelines`), and the intro stays generic. The mechanism is `test/e2e/prompt.test.ts`: it asserts that an SDK session with `tools: ['read_file']` and a narrowed group session carry the generic intro, and that a default session still lists its execution tools. The review check is the prompt item in [REVIEW.md](REVIEW.md).
