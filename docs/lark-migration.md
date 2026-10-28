# Feishu to Lark migration (breaking)

Vela's adapter is now consistently named Lark. This changes Vela identifiers only: `@larksuiteoapi/node-sdk`, its default region, real provider domains, event names (`im.message.receive_v1`, `card.action.trigger`), fields, scopes and transport behavior stay the same. This does not move an app between Feishu and international Lark.

## Cutover before merge/deployment

Stop every Vela process using the affected data/settings. Keep ingress stopped throughout migration and verification. The utility cannot stop your service manager or detect every other writer.

An administrator must move these environment/secret values, then remove the old names. The code and utility never read out or change deployment secrets:

| Old name | Required new name |
|---|---|
| `FEISHU_APP_ID` | `LARK_APP_ID` |
| `FEISHU_APP_SECRET` | `LARK_APP_SECRET` |
| `FEISHU_OWNERS` | `LARK_OWNERS` |
| GitHub Actions secret `WAKE_FEISHU_VELA_WEBHOOK_URL` | `WAKE_LARK_VELA_WEBHOOK_URL` |

Keep values, app permissions and webhook endpoints unchanged. The wake workflow's sink is `lark`; routing labels and delivery IDs stay the same. Do not paste secret values into logs or the PR. Old environment names cause an actionable error, even if a new name is also present; there is no precedence guess.

Update SDK imports/calls: `feishu` → `lark`; `FeishuOptions`, `FeishuCard`, `FeishuCardAction`, `FeishuCardResponse`, `FeishuHistoryMessage`, `FeishuMessageEvent`, `FeishuSentMessage`, `FeishuTransport` → the corresponding `Lark*` names. The package is still `@glows777/vela-lark`; the umbrella re-exports the new names. Old public aliases are removed.

Update `builtin:feishu` (including +/- selectors and `-e`) to `builtin:lark`, `extensionConfig.feishu` to `.lark`, all current `feishu_*` tool references to `lark_*`, and prompt-section keys `feishuChannel`/`feishuTopic` to `larkChannel`/`larkTopic`. Update custom factories, tool loadouts, exact permission rules and tool-selection patterns in your source. Custom interpolation variables such as `$FEISHU_CHATS` are operator-owned, rather than built-in environment defaults: if configured, rename both that reference and its external variable explicitly. `PermissionRules` supports exact names and `*` only; tool-selection globs are a different API. There is no persisted SDK permission-map setting to rewrite. Unrecognized custom configuration containing old tool/env identifiers stops the utility for its owner's explicit migration, so a deny is never guessed or merged.

## Dry run, backup, apply

Use this checkout's Bun utility. Pass the actual `dataDir` and **every** user/project JSON settings file used by this deployment, separately; the utility does not discover arbitrary configuration or edit `.env`, shell scripts, SDK source, secrets or service definitions. Repeat for other data directories only after reviewing shared settings explicitly.

```sh
bun scripts/migrate-lark.ts --data-dir /absolute/vela-data \
  --settings /absolute/user/settings.json --settings /absolute/project/.vela/settings.json
# Review the changed paths and resolve every reported collision/orphan. No writes have occurred.
bun scripts/migrate-lark.ts --data-dir /absolute/vela-data \
  --settings /absolute/user/settings.json --settings /absolute/project/.vela/settings.json --apply
```

Dry run is the default. Apply first snapshots the entire data directory and supplied settings to `<dataDir>.pre-lark-v1/` (private directory, settings mode 0600). Copies dereference symlinks: a linked data root, nested channel tree or settings file becomes independent snapshot contents, never a link back to live data. Existing backups stop rather than overwrite. Ensure sufficient disk space for linked contents too. Unreadable, broken or cyclic links fail the copy before the migration journal or live replacements; inspect any partial backup before explicitly removing it for another attempt. Preserve this backup until cutover and validation are complete.

Preflight computes old/new logical keys with `channelSessionId` from each actual channel/chat/topic tuple, including hashed keys. It rejects old/new chat, route, storage or selector collisions; ambiguous custom permissions; unknown old sessions/stores/usage/routine targets; malformed index/routines; and source drift. Resolve reported cases explicitly; the utility never merges or discards conversations.

The write set is settings JSON, `channels/index.json`, `channels/routines.json`, and `channels/migration.json`. Each replacement uses the existing synced temporary-file/rename writer. The version-1 journal is written as pending **before** the first replacement. While pending, channel startup fails before any transport starts. After an interruption, rerun the same command with the same settings list; every planned file must still match its before/after bytes. External edits stop resumption. In-progress migration is resumed explicitly, never by starting the bot.

Recognizable historical sender-only (`feishu-ou_*`) and per-chat/sender (`feishu-oc_*-ou_*`) transcripts, including the old `unknown` sender fallback, stay as read-only archives in place. Their session header (or legacy checkpoint/message format) must match the historical form. Their artifact directories stay in place too. Neither migration nor Lark startup turns these archives into routes, combines them with group history, or automatically resumes them. Unknown/hashed orphan IDs and malformed would-be archives still stop for explicit reconciliation.

Session IDs (`activeSessionId` and `previousSessionIds`), JSONL, tool-history/output references, timestamps, user text and append-only usage ledgers are not rewritten. The directory records `legacyKey` and `storageKey`: runtime lookup maps old usage keys to canonical routes once, while workspace, memory and attachment paths keep their original physical location. New topics in a migrated chat inherit that store; fresh chats use Lark-derived paths. Routines change only channel/target routing; schedules, IDs and firing markers remain unchanged. Already-delivered scheduled inputs are not counted or submitted again.

After apply, rerunning reports an empty write set. Any newly introduced legacy state after completion requires investigation instead of overwriting the previous migration. If settings were omitted from the original apply, a later invocation names the additional files and stops without writing them. Keep the completed journal and backups: stop all writers and explicitly update those settings using the cutover table above. Alternatively, if no later writes exist, restore the complete paired pre-migration state and run a fresh dry run/apply with every settings file. Do not delete only the journal or blindly rerun over the backup.

## Validate and rollback

Before reopening ingress, start the migrated service with canonical variables/config and check the known topic/session, shared memory/workspace/attachments, pending recovery, routine list and usage totals. Verify an owner DM, group/topic reply, unowned topic rejection and passive silence. Use isolated fixtures first; do not generate paid model traffic merely to validate naming.

The next npm release remains on hold until an explicit release authorization; merging this PR does not authorize publication. npm ownership/trusted-publisher setup remains an administrator step.

A source revert alone cannot undo new Lark writes. If no post-migration writes exist, stop all ingress and restore the complete data/settings snapshot together with the old code and old environment/secret names. Snapshots materialize linked contents rather than recreating link topology: restore bytes to the original destinations through administrator-owned links, retaining their layout so existing absolute tool/output references remain usable. After any new writes, reconcile session/routine/index/usage state before restoring a backup; prefer a forward fix to discarding work. Never restore only the directory index or merge old/new conversations automatically.
