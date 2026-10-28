# Agent lessons

After a miss is confirmed, write a lesson. Record the trigger path, the layer that should have caught it, and the mechanism patch. The layer is pre-PR, AI/bot review, CI, human, or post-merge. The patch is a line in [REVIEW.md](../REVIEW.md), a lint, or a verify-vela journey. A lesson with no mechanism change is not closed.

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
