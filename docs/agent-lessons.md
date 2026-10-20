# Agent lessons

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
