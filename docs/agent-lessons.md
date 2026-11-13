# Agent lessons

After a miss is confirmed, write a lesson. Record the trigger path, the layer that should have caught it, and the mechanism patch. The layer is pre-PR, AI/bot review, CI, human, or post-merge. The patch is a line in [REVIEW.md](../REVIEW.md), a lint, or a verify-vela journey. A lesson with no mechanism change is not closed.

## Background memory work must respect tool availability and atomic merges

[PR #307's review](https://github.com/glows777/Vela/pull/307#discussion_r4504727382) found that a deny-only background gate let `memory: ask` sessions consolidate without approval. The pre-PR tests covered `deny`, but not the approval-required path or an already-due shared inbox. That fix required `allow` for collection and both automatic and manual runs. Since [#348](https://github.com/glows777/Vela/issues/348) removed the permission API, dream follows the memory tool's availability: a session with `tools: ['-memory']` neither collects nor consolidates. User extensions handle confirmation for ordinary tool calls.

The [same review](https://github.com/glows777/Vela/pull/307#discussion_r4504727383) found that independently skipping a changed merge destination still deleted its source. The pre-PR single-note race did not cover dependent operations. Dream now checks every full note supplied to the model plus create targets before applying any operation and retains the whole inbox on conflict. This includes a duplicate destination that the model reads but does not update; a live edit to that note must still prevent deletion of its source. Faux cases reproduce both operation orders and a create collision; the memory SDK journey in [verify-vela](../.skills/verify-vela/journeys.md) covers tool exclusion, a description-only live edit, retained evidence and a successful refreshed retry. AI/bot review caught both misses; these entry-path scenarios are the verification mechanism.

The next Leader review found retained failed/skipped inboxes were immediately due again, causing a full model call on every later turn. Pre-PR checks covered a single failure and manual recovery, not automatic follow-up traffic. Automatic retry now counts newly collected turns independently of inbox truncation and uses the last run time for the 24-hour threshold; `/memory` exposes failed/skipped outcomes. The retry cadence faux scenarios and [SDK journey](../.skills/verify-vela/journeys.md) are the mechanism, with one code-fence unwrap at the model response boundary and unchanged strict operation validation.

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

AI/bot review should have caught it. The case now finds the hop with `lastUserText`. The mechanism is the channel end-to-end item in [REVIEW.md](../REVIEW.md). Do not assert `model.calls.at(-1)` across concurrent channel sessions. Run `bun test test/e2e/channel-handoff.test.ts` before merging a handoff change.

## A channel change updates the channels guide

[Issue #244](https://github.com/glows777/Vela/issues/244). PR #242 shipped the hand-off tools, status lines and topic start context but updated only `CHANGELOG.md` and the verify-vela journeys, so `docs/channels.md` kept the pre-handoff dispatch story until a separate issue. Behavior that a person or a model can see needs the docs pages that describe it, in the same pull request as the changelog entry. The mechanism is the docs item in [REVIEW.md](../REVIEW.md) and the Docs section of the pull request template.

## A first-run wizard hides the recovery hint it replaces

[Issue #279](https://github.com/glows777/Vela/issues/279). A first run without a model rendered the header's `/model` hint and the `[model] No model available…` diagnostic before the setup wizard opened, so the screen told the user to do what the wizard was already doing, and both strings stayed in the transcript afterwards.

Model guidance belongs to a state the wizard is about to leave: while the startup wizard runs, it owns those messages, and a cancelled setup brings the hint back. The mechanism is the prefix assertion in `test/e2e/cli.test.ts` (no hint or diagnostic before `Choose a provider`) and the in-process TUI case that checks the hint returns after cancel; both fail without the quiet startup open.

## SDK warnings in interactive mode belong in the chat log

[Issue #337](https://github.com/glows777/Vela/issues/337). After [#335](https://github.com/glows777/Vela/pull/335) upgraded the AI SDK, an MCP record tool with a `propertyNames` schema made the OpenAI-compatible adapter report a compatibility warning. The SDK writes warnings through `process.emitWarning`, not `console.*`, so the TUI's console capture missed them: stderr painted over the screen on every request. The pre-PR tests covered the request payload and the returned warning, not where the warning was displayed.

Interactive mode now installs `globalThis.AI_SDK_LOG_WARNINGS` for its lifetime, shows each formatted warning once, and restores the previous value on shutdown. The layer was human review: #334 named this display follow-up but closed without an issue for it. The mechanism is the TUI case in `test/e2e/tui-sdk-warnings.test.ts`, which drives the real OpenAI Responses adapter and a `propertyNames` tool, and the SDK warning journey in [verify-vela](../.skills/verify-vela/journeys.md) that repeats it through the real CLI.
