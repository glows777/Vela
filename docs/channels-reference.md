# Channels reference

This page is for building on the channel interface: writing a channel, the gateway lifecycle, custom Lark transports and external event subscriptions. To run Vela in a group chat, see [Channels](channels.md).

## SDK host access

An embedded SDK host uses `createRuntime()` (or connects to `vela daemon` via `connectRuntime()`) and interacts with registered Runtime channels through `runtime.channels`:

```ts
import { createLarkChannelAdapter, createRuntime } from '@glows777/vela'

const runtime = createRuntime({ agentDir })
await runtime.ready()
await runtime.registerChannel(createLarkChannelAdapter(larkOptions))
await runtime.recover()

const channels = await runtime.channels.list()
const chats = await runtime.channels.chats('lark')
const off = runtime.events.subscribe((event) => handleRuntimeEvent(event))
const receipt = await runtime.channels.submit('lark', {
  chatId: 'oc_group',
  text: 'Please check the totals',
  author: { id: 'desktop-alex', name: 'Alex' },
  newTopic: { title: 'Totals check' },
})
off()
await runtime.dispose()
```

`runtime.channels` provides JSON-serializable host operations (`list`, `setEnabled`, `chats`, `submit`), while `runtime.timers`, `runtime.subscriptions`, `runtime.bindings`, `runtime.sessions`, and `runtime.events` manage scheduling, event subscriptions, channel bindings, sessions, and live delta/status streams uniformly across CLI, daemon, and desktop hosts.

### Connection state

`runtime.channels.list()` and channel status events expose live adapter state (`{ channel, enabled, status, chats }`). Initial, stopped, and unconfigured adapters report disconnected state until startup completes cleanly.

### Lark groups and visible history

With `createLarkChannelAdapter(options)` registered on `LocalVelaRuntime` via `await runtime.registerChannel(adapter)` (or hosted by `vela daemon`), hosts query configured groups via `runtime.channels.chats('lark')`, inspect channel-backed sessions via `runtime.sessions.list()`, read history via `runtime.sessions.messages(...)`, and post messages via `runtime.channels.submit('lark', ...)` (returning the session/message receipt). Live updates stream over `runtime.events.subscribe(...)` and `runtime.events.subscribeDeltas(...)`.

## Writing a channel

Register a `ChannelAdapter` with `await runtime.registerChannel(adapter)`. The adapter types are exported by `@glows777/vela`, and [echo-channel.ts](../examples/extensions/echo-channel.ts) gives a minimal runnable example. Enforce chat allowlists before calling `ctx.ingest(...)`: admitted messages share their project/session transcript and tools.

| Member | Required | Contract |
| --- | --- | --- |
| `name` | Yes | Stable channel identifier (e.g. `'lark'`, `'echo'`), recorded on `projects` and `channel_bindings` |
| `start(ctx)` | Yes | Connect/start receiving input using `ctx.ingest(...)` and report status via `ctx.status(...)` if applicable |
| `stop()` | Yes | Close transport/resources cleanly when `runtime.dispose()` shuts down |
| `deliver(message)` | Yes | Deliver an outbound `ChannelOutboundMessage` (`reply`, `topic_start`, `forward`, `file`, `announce`) and return `{ delivered, rootId?, threadId?, externalMessageId? }` |
| `fetchAttachment?(attachment)` | No | Lazily download inbound image/file bytes when needed by a run |
| `listChats?()` / `listMessages?()` / `submitFromHost?()` | No | Optional host inspection and submission hooks exposed via `runtime.channels` |

### Messages and runtime

`ChannelAdapterContext` provides `{ ingest }` at minimum, and daemon/runtime hosts wire full durable ingress into `inbox_events` (`channel_bindings`), outbox delivery (`outbox`), timers (`timers`), and webhook subscriptions (`subscriptions`) in `vela.db`. Outbound replies and topic starts are persisted in SQLite `outbox` and retried safely until `deliver(...)` acknowledges delivery.

### Shared topic capabilities

In Runtime sessions, platform-agnostic control tools (`session_start`, `session_forward`, `session_list`, `session_read`, `session_message`, `timers`, `subscriptions`, `wait_for_input`, `send_file`, `skip_reply`) are wired by `driver/runtime-tools.ts` according to session kind (`group` vs `topic` vs `direct`) and active tool selection. `lark_search_history` remains Lark-specific.

### Topic commands

In an owned Lark topic, send `!stop`, `!restart`, `!status`, or `!timers` as the whole message to bypass model turns and inspect or control the topic run. `!stop` interrupts the active run cleanly while keeping history; `!restart` closes the active physical session generation cleanly; `!status` prints model/token/cost status; `!timers` lists configured timers in the local timezone without invoking the model.

### Restart recovery

Runtime stores projects, sessions, bindings, timers, subscriptions, background jobs, inbox events, and outbox rows in a single transactional SQLite WAL database (`$VELA_DIR/vela.db`). On startup, `await runtime.ready()` initializes runtime extensions and `await runtime.recover()` runs crash recovery across interrupted runs, due timers (`TimerScheduler` catches up at most once across downtime for routines), undelivered outbox entries, and orphaned background jobs.

### Run feedback lifecycle

Progress updates stream from `runtime.events.subscribe(...)` and `runtime.events.subscribeDeltas(...)` (`run_started`, `run_ended`, tool/compaction deltas, `queue_updated`, and `audit`). Channel adapters such as `LarkChannelAdapter` drive typing/progress cards and final reactions (`OnIt` / `DONE` / `CrossMark`) from these runtime events and outbox completion hooks.

## Gateway lifecycle

On receiving a channel message via `ctx.ingest(...)`, Runtime:

1. Resolves or admits the `ChannelBinding` and target session (`group`, `topic`, or `direct`) in `vela.db`.
2. Serializes or steers work per session queue; active topic/DM messages enqueue cleanly and record durable provenance (`inbox_events`).
3. Runs `VelaAgentDriver` against the session's `ExecutionEnv`, appending `vela_messages` / `usage_records` and outbox deliveries transactionally.
4. Delivers replies, topic starts, files, and announcements asynchronously via the adapter's idempotent `deliver(...)` and emits `channel` / `run_*` events.

`runtime.dispose()` stops registered channels, aborts active runs, drains pending persistence, and closes `vela.db`.

## Custom transports

Custom `LarkTransport` implementations must provide `getBotId`, `getSenderName`, `listMessages`, `listTopicMessages`, `reply`, `startTopic` and `forward`. `listTopicMessages(threadId, pageToken?)` returns `{ items, pageToken? }` in ascending creation order, with a next token only when more pages remain; use a thread container, page size 50 and no time filters. `listMessages` returns newest-first history with millisecond `create_time`; `reply` returns `{ messageId, createTime }` from the service's successful reply receipt. Sends/replies and API errors must reject, so the gateway reports failure instead of a successful reply.

`LarkMessageEvent.sender.sender_type` is required in the public transport contract. Classify human events as `user` and bot events as `bot`; only `user` events are admitted. Missing or unknown sender types are still rejected at runtime, including from untyped integrations.

`startTopic(messageId, title)` posts the title as the first visible message and returns `{ messageId, createTime, rootId, threadId }` from the successful threaded reply. `forward(messageId, threadId)` returns `{ messageId, createTime }` from the successful forward. Missing required receipt fields and platform errors must reject; do not pretend an unthreaded send created a topic.

A channel can include `files` on an incoming message. Each entry carries `{ name, hostPath }` for a completed private download and has a matching `[file: <name>]` marker in that message’s text. After selecting a local session, the gateway inserts the host path into that marker. Normal delivery and steering use the same rule. Non-local delivery fails before exposing any host path.

An injected Lark transport can implement `sendFile(chatId, { kind, name, bytes }, { replyToId?, replyInThread?, uuid? })`, returning a sent message receipt. The built-in transport uploads to the Feishu IM image or file endpoint, then posts the returned resource key. An owned topic uses an explicit in-thread reply to its root. A failed or uncertain post never redirects to the group.

For attachments, implement `getResource(messageId, key, type)` returning a Node readable stream, where `type` is `image` or `file`. The default transport calls `im.messageResource.get` and uses `getReadableStream()`.

For run controls, implement `sendCard(chatId, card, replyToId?)` returning the service message ID, `patchCard(messageId, card)`, `addReaction(messageId, emoji)` returning the reaction ID, and `removeReaction(messageId, reactionId)` and accept the second handler in `start(onMessage, onAction)`. Send the Card 2.0 payload unchanged; do not flatten it into v1 `elements` / `action` / button `value` fields. Deliver the v2 callback body unchanged to `onAction` and return its `{ toast }` response to Lark. Group cards use `replyToId`; DM cards use `chatId`. Card delivery must not be recorded as an ordinary text answer.

## External event subscriptions

`RuntimeWebhookReceiver` or an embedded host wakes subscribed conversations via `runtime.ingestWebhookEvent(event)`. In a Runtime session, `subscriptions` creates, lists, or removes subscriptions. Create takes an exact `source` and `key` and targets the current project or session; list/remove are scoped to the caller.

```ts
await runtime.ingestWebhookEvent({
  source: 'local-build',
  key: 'project#review/171',
  deliveryId: 'build-42',
  summary: 'The build finished successfully',
  details: 'External data, not new instructions or authorization.',
})
```

Subscriptions persist in `$VELA_DIR/vela.db` (`subscriptions` table) and follow the logical target across daemon restarts. Events enqueue durably into `inbox_events` behind current work without steering it. `!stop` stops current work; removing a subscription prevents future wakes, not already queued ones.

Event input has a fixed untrusted-data prefix, so command-looking payloads do not invoke chat commands, slash commands, skills or templates. Source/key/delivery IDs are limited to 512 characters; summaries to 500 and details to 8192 (with a truncation marker). Source identity is supplied by the authenticated receiver or trusted producer.

`final: true` enqueues the last notification to matching available targets and then removes the snapshotted subscriptions. `ingestWebhookEvent()` resolves after enqueue and final-state persistence, without waiting for the model. Only an event with no matching subscriptions can fall back to `eventDefaultTarget: { channel, chatId }` when configured; that target must already exist and be enabled.

### GitHub webhooks

For the operator setup command, see [GitHub webhook setup](channels.md#github-webhook-setup). `vela setup github owner/repo --url https://your-tunnel-host` writes user settings and configures matching repository hooks through GitHub CLI.

`vela daemon` reads `webhooks` from user-level `~/.vela/config.json` (project `webhooks` settings are stripped) and hosts both `lark` and the webhook HTTP listener automatically (`RuntimeWebhookReceiver`). It is absent by default. To configure it manually, add top-level `webhooks` to `~/.vela/config.json`, supply the secret through the existing `$VAR` interpolation (or a literal in private user settings), and let `vela daemon` reload automatically:

```json
{
  "webhooks": {
    "port": 8787,
    "github": {
      "secret": "$VELA_GITHUB_WEBHOOK_SECRET",
      "repositories": ["glows777/Vela"],
      "apps": ["github-actions"],
      "issueLabels": ["to:vela"]
    }
  }
}
```

When using an embedded SDK Runtime, wire `new RuntimeWebhookReceiver(options, (event) => runtime.ingestWebhookEvent(event), logger)` directly. Repository names must be explicit `owner/repo` values; no wildcard. `apps` defaults to `github-actions`; an explicit list replaces it. The port defaults to 8787 (`0` selects an ephemeral local port for fixture/embedded use). The host is fixed to **127.0.0.1** and has no override.

`issueLabels` filters the repository Issue feed, not PR subscriptions. The existing array matches any listed label. For example, use `{ "all": ["to:vela", "status:ready"] }` to require both labels. In the object form every label in `all` is required, and at least one in `any` is also required when `any` is nonempty. Both lists are optional; if neither names a label, including the default `[]` and `{}`, the feed stays silent. Labels are trimmed and must not be empty; the object accepts only `all` and `any`.

For `labeled`, an array or an object without nonempty `all` matches only the applied label. With nonempty `all`, the applied label must be named in `all` or `any`, and the Issue must satisfy the full filter after application. Adding an unrelated label never wakes the feed.

Two subscriptions share this receiver:

- **Repository Issue feed.** Subscribe once from the group that should receive Issue work: `subscriptions({ action: "create", source: "github", key: "github:glows777/Vela#issues" })`. Ordinary Issues and their comments then arrive in that group.
- **One pull request.** Subscribe from the topic that opened or took over the PR: `subscriptions({ action: "create", source: "github", key: "github:glows777/Vela#pr/171" })`. Review, CI, comment and close/merge feedback goes to that topic.

These are exact keys, including repository spelling. Each event matches one key, so an ordinary Issue comment never reaches PR subscriptions and a PR comment is not duplicated into the repository feed. Enablement and tool selection still apply; a signed webhook cannot choose a chat or grant authority.

Configure a GitHub repository webhook with JSON content type, a high-entropy secret matching the setting, and payload URL `https://<your-tunnel-host>/events/github`. Select only:

- **Check suites**, action `completed`, from an allowlisted app. Each supplied PR mapping receives that suite's conclusion, exact SHA, time and link. This is not an aggregate verdict for all PR CI. Empty PR mappings are logged and dropped; there is no token/API lookup or branch-name guessing.
- **Pull request reviews**, action `submitted`: reviewer, state, commit SHA, link and body preview. When the payload carries the review id, the notice also names it and links its inline comments as `GET /repos/<owner>/<repo>/pulls/<n>/reviews/<id>/comments` for the subscriber to read with its own tools; without an id it stays a plain notice and invents no endpoint. No fabricated inline-comment count and no separate inline-comment deliveries; a reply in an existing review thread arrives as another `submitted` review with an empty body.
- **Issue comments**, action `created`, on pull requests: author, link and body preview. Delivered only to that PR's subscription.
- **Issue comments**, action `created`, on ordinary Issues: author, issue title, link and body preview. Delivered only to the repository subscription, and only for an Issue matching the `issueLabels` filter.
- **Issues**, actions `opened`, `closed` and `labeled`: issue title, author and link, plus the body preview on `opened`; all three follow the `issueLabels` rules above. Issue events feed only `github:<owner>/<repo>#issues` and are never final, so closing an Issue leaves the repository subscription in place.
- **Pull requests**, action `closed`: both merged and closed-unmerged are final. Enqueue the final notice, then remove matching subscriptions; reopening requires a new subscription.

This set does not cover every push, PR edit or reopen, Issue edits, assignments or other labels, separate inline review comment deliveries (read them from the review's endpoint), or an aggregate CI verdict; there is no polling or token/API lookup. An event type outside this table is dropped with one bounded `debug` line naming it.

Vela-authored Issue or PR conversation comments and reviews must end with an independent final line `<!-- vela:event-origin -->`. The adapter checks the complete body before truncation and ignores those events; unmarked content by the same author still wakes the conversation. This marker is a collaboration convention, not authentication. Summaries/previews are bounded (500/8192 characters with a truncation marker), queued as untrusted data, and never download logs, diffs or payload URLs.

The GitHub adapter registers only `POST /events/github`. The receiver limits the raw request to **1 MiB**, including streamed bodies without Content-Length. It verifies [`X-Hub-Signature-256` HMAC-SHA256](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) against the original bytes with a constant-time comparison before JSON parsing. Wrong/missing signatures return 403 without consuming a delivery ID; malformed authenticated payloads return 400, oversize bodies 413, and publication failures 503. Unconfigured routes/other methods return 404/405.

After authentication, the original `X-GitHub-Delivery` ID is synchronously recorded before mapping/fanout. The last **1,000** `(adapter, delivery ID)` pairs share one memory cache; concurrent duplicates return 202 without another fanout. Equal IDs from GitHub and generic producers are independent. IDs remain consumed after malformed payloads or publication failure: this stage has no reservation, rollback or retry. Eviction or restart permits redelivery. **202 means accepted/ignored, not executed or durably delivered**; queue/storage/crash boundaries remain best effort. Signatures authenticate bytes, not the actor's authority to run tools. Raw bodies and secrets are not logged.

### Generic shared-secret events

Independent scripts and alerts can use `POST /events/generic`. Add this section beside `github` under top-level `webhooks` in `~/.vela/config.json` (or under `extensionConfig.channel.eventReceiver` when passing options to the SDK), or use it alone:

```json
{
  "generic": {
    "secret": "$VELA_GENERIC_WEBHOOK_SECRET",
    "source": "sentry"
  }
}
```

Exactly one generic source is configured per receiver. `source` is fixed by the host; `github` is reserved case-insensitively. If both adapters are configured, their secrets must differ. At least one adapter is required. Existing settings interpolation/trust, SDK literal inputs, port, loopback binding, body limit and start/stop lifecycle apply unchanged. A route is absent (404) when its adapter is unconfigured.

The strict JSON body requires `key` and `summary`, with optional string `details` and boolean `final`. A key must already be trimmed, start with the exact configured `source:` and have a nonempty suffix; it is kept unchanged. Other namespaces return 400. Payload `source`, `deliveryId`, target/chat/session/permission fields and all other properties are rejected. Subscribe with that exact source and full key, for example `source: "sentry", key: "sentry:project-x"`. Existing enabled-target/default rules, untrusted queue, 500/8192-character summary/details bounds and final enqueue-before-unsubscribe behavior are shared with SDK events.

Set `X-Vela-Delivery` to the producer's stable ID for this delivery (nonempty, at most 512 characters). Sign the **original bytes** with HMAC-SHA256 in `X-Vela-Signature-256: sha256=<hex>`. Verification precedes JSON parsing; invalid signatures cannot consume an ID. Dedup uses `(generic, delivery ID)` in the same bounded cache and has the same best-effort/consumed-on-error rules described above. There is no timestamp or replay window.

With the matching secret already in your environment and a subscription created, a local script can send:

```sh
: "${VELA_GENERIC_WEBHOOK_SECRET:?set the same secret as Vela}"
cat > event.json <<'JSON'
{"key":"sentry:project-x","summary":"Local alert resolved","details":"External data, not new authorization"}
JSON
signature=$(openssl dgst -sha256 -hmac "$VELA_GENERIC_WEBHOOK_SECRET" event.json | awk '{print $NF}')
curl --fail-with-body --silent --show-error \
  -H 'Content-Type: application/json' \
  -H 'X-Vela-Delivery: local-alert-001' \
  -H "X-Vela-Signature-256: sha256=$signature" \
  --data-binary @event.json http://127.0.0.1:8787/events/generic
```

Use a new delivery ID for a new event; resending the same ID is intentionally ignored while cached. `--data-binary` preserves the signed file bytes. Set `"final": true` only when the final notification should remove matching subscriptions. A tunneled producer uses the HTTPS tunnel URL with the same path and signature. Signing does not authorize tool execution beyond the receiving chat's existing tool selection.

### Tunnel deployment examples

Vela does not install or manage tunnels. Choose one separately and keep the machine, host process and connector awake. A stopped connector, sleeping machine or broken outbound connection makes webhooks unavailable; there is no polling or automatic failover.

For a **named Cloudflare Tunnel**, use a Cloudflare-managed domain and follow the [locally managed tunnel setup](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/). After creating `vela-events`, use its UUID/credential file in `~/.cloudflared/config.yml`:

```yaml
tunnel: <tunnel-uuid>
credentials-file: /absolute/path/<tunnel-uuid>.json
ingress:
  - hostname: vela-events.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Run `cloudflared tunnel route dns vela-events vela-events.example.com`, then `cloudflared tunnel run vela-events`. The webhook URL is `https://vela-events.example.com/events/github`. Account/domain setup and service supervision remain deployment tasks; Quick Tunnel addresses are not a stable deployment.

For **Tailscale Funnel**, no separate domain is needed. On an eligible tailnet with HTTPS and Funnel permission enabled, run `tailscale funnel --bg http://127.0.0.1:8787` and use the printed HTTPS hostname plus `/events/github`. Follow the [Funnel prerequisites](https://tailscale.com/docs/features/tailscale-funnel) and [CLI reference](https://tailscale.com/docs/reference/tailscale-cli/funnel); Funnel is public ingress, while Serve alone limits access to the tailnet. Keep webhook signature validation enabled with either tunnel.
