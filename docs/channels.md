# Channels

A channel connects a chat service to Vela. The gateway keeps **one shared session per chat**, identified by the channel name and `channelId` (for example `feishu-oc_456`). Different chats have separate history and can run concurrently. Within a chat, everyone sees the same conversation history. Messages queue in order by default; Feishu also offers Steer and Stop during a run.

**Enabling a chat means trusting everyone in it with this machine.** Feishu gives every member of an enabled chat the `owner` role, including bash, files, memory and extension tools. There is no sandbox or per-member guest boundary. See [Security](security.md#channel-senders) before enabling a group.

## Feishu

The built-in `feishu` extension uses Feishu's long connection (WebSocket), so no public URL is needed. It is loaded by default in the CLI.

1. Create and publish a Feishu custom app with bot capability enabled.
2. In **Events & Callbacks**, choose long-connection mode, subscribe to the event `im.message.receive_v1`, and add the callback subscription **Card action trigger** (`card.action.trigger`). Use the callback subscription, not the older card request-URL setting; this integration dispatches v2 callbacks over the same long connection.
3. Grant the API permissions below and add the bot to groups you intend to enable.
4. Configure the app credentials, owner open_ids and enabled chat_ids in [settings](settings.md):

   ```json
   {
     "extensionConfig": {
       "feishu": {
         "appId": "cli_xxx",
         "appSecret": "$FEISHU_APP_SECRET",
         "owners": ["ou_aaa"],
         "chats": ["oc_trusted_group"]
       }
     }
   }
   ```

   `owners` and `chats` accept string arrays or comma-separated strings. `FEISHU_APP_ID`, `FEISHU_APP_SECRET` and `FEISHU_OWNERS` remain environment defaults; settings take precedence. To supply chat ids from an environment variable, set `"chats": "$FEISHU_CHATS"` in settings.

5. Start `vela` in interactive mode and keep it running. The SDK equivalent is `feishu({ appId, appSecret, owners, chats })`, followed by `await vela.ready()` and `await vela.startChannels()`.

### Enablement and replies

- `chats` lists the chat_ids that may use the bot. Every member of a listed chat has owner access. A listed DM also works.
- `owners` contains people's open_ids. Their **direct chats** are always enabled, including when `chats` is empty. Being an owner does not enable a group they happen to speak in.
- Every other group or DM is dropped without a reply, a model call or history/name lookup. Vela logs `[feishu] ignored message from chat <chat_id>` so you can copy the id into settings. Restart after changing settings; there is no in-chat `/enable` command.
- Empty `chats` produces one startup notice: only owners' direct chats are enabled.
- At the top level of enabled groups, only messages that **@ this bot** trigger a run. Untagged top-level messages are dropped before content logging, name/history lookup or attachment preparation. In an owned topic, any member can reply without @. Vela resolves its bot open_id at startup; if that fails it logs a warning and ignores group messages until a successful restart. Owner DMs still work.
- Group answers use `im.message.reply` on the triggering message id. DMs use `im.message.create`. Feishu controls whether an already-threaded trigger receives a threaded reply.
- A second top-level @ (or DM message) during a run receives a Queue / Steer / Stop card. Queue is the default if nobody clicks. See [Run controls](#run-controls). Other chats can still run concurrently.
- Text and rich-text (`post`) messages become plain text, with mention markers removed. Image messages and `img` elements in posts go to the model as images; an image alone triggers a run in an enabled DM. Existing image normalization resizes or drops invalid images with a reason, and non-vision models receive the existing image placeholder.
- File messages are streamed to `<dataDir>/channels/<session id>/files/<message_id>-<name>`. Only a sanitized base name is used, with portable filename characters and a UTF-8 byte limit that leaves room for the message ID and extension. The model receives `[file: <name>, saved at <absolute path>]` and can use `read_file` or bash tools to inspect it. Files above **20MB** are stopped, the partial file is removed, and the sender receives a too-large reply. Only completed downloads are published at the final path; a redelivered message reuses its existing regular file. Downloads interrupted by process termination may leave a `.part` file, which is never reused as a completed attachment. Download failures reply with the cause and an `im:resource` permission hint. Files remain with the session for resumed use; there is no automatic cleanup or native PDF/document input.
- Audio, video, stickers and merged forwards remain unsupported and receive a short reply saying text, images and files are supported, only in an enabled DM or when this bot is mentioned in an enabled group.
- The last 1000 incoming message ids are remembered to suppress duplicate event delivery.

### Topics

An @ inside a Feishu topic opens its own session, identified by channel, chat and root message ID. Different topics run concurrently without sharing transcripts; top-level messages and DMs retain one session per chat. This separates conversation context, not the filesystem or global memory.

A topic is owned when its session exists. After restart or idle eviction, the gateway opens and resumes it through its per-session queue before preparing an untagged input. An unknown untagged topic is ignored without resolving names, reading platform history, downloading attachments or writing an empty session file. Existing history is loaded once for the next run; interrupted work does not resume automatically.

An untagged reply during a topic run automatically steers it without a Queue/Steer card. An idle reply starts the next run. Each run posts one shared progress card with **Stop** inside its topic. Stop aborts only that run, retains its session history and expires the callback; the next message continues the conversation. If the Stop card cannot be sent, Vela reports the cause and does not start the task.

The first @ entering a topic without a saved session reads every page of history using `container_id_type: thread` and the platform `thread_id`, in chronological order. The root message ID is used for session identity, not as the history container. Text/post content includes earlier bot answers, excluding the triggering message, messages newer than its timestamp, recalled messages and control cards. Other messages at the same timestamp remain included. Historical file content is not downloaded; at most four historical images are attached. A failed topic-history read is reported instead of running with silently incomplete context. Once the topic is owned, both explicit @ mentions and untagged replies use the existing session context without rereading topic history.

### Channel dispatch

The top-level group session answers short questions directly: answerable from the visible conversation, in one reply, without tools. Its prompt sends investigation, execution and longer exchanges into topics. It has three dispatch tools in addition to its existing tools:

- `feishu_start_topic({ task })` replies under the current message with `reply_in_thread: true`, then independently enqueues the explicit task in its topic session. It returns the platform receipt without waiting for task completion, so another top-level question can run while the topic works. The task text is its whole brief, so it must include the goal and needed facts. The triggering message’s own images are carried over, excluding images from group history. The channel transcript is not copied into the task, and a successful handoff suppresses the channel's duplicate final reply.
- `feishu_forward_to_topic({ root_id })` forwards the current original message to an observed owned topic in the same group, then explicitly enqueues its content with the original sender's name. It does not depend on receiving the bot's forwarded message as an event. A running target is steered; an idle target starts its next run.
- `feishu_list_topics()` reports observed owned topics and current execution state. Its result states the observation start time and warns that earlier topics may exist: an empty list does not mean there are no tasks. Coverage is process-local, not a complete historical directory after restart; a persisted topic returns to the list when observed again. Persistent session ownership remains independent of this directory. When a follow-up refers to earlier work absent from the list, the channel prompt requires a notice that the earlier topic could not be found, at the beginning of the new topic entry, instead of silently duplicating it.

If Stop is selected while a create/forward API request is pending, its eventual receipt cannot enqueue topic work. Feishu may already have accepted the remote message; Stop does not retract that message.

Topic sessions and DMs do not see these three tools in their model tool list. Each tool also validates the caller's active group context; forwarding rejects targets outside that group. Topic prompts say to work on one task, leave progress narration to the automatic display, give the result when done, and ask one decision question then end the run when blocked. Progress rendering is added separately; this step still uses the minimal Stop card.


### Task feedback

An admitted group message receives an `OnIt` reaction before name/history/attachment preparation and model work. Unknown untagged topics are checked for ownership first. The reaction becomes `DONE` after the result is sent, or `CrossMark` on failure or Stop (the card explicitly says “Stopped”). A channel-to-topic handoff keeps the original reaction pending until the topic finishes; accepted steers finish with that run.

The same Stop card is updated in place with the current stage and up to eight bounded tool summaries, without thinking content, tool arguments or raw logs. Updates are serialized and coalesced at no more than four per second, with a 15-second heartbeat during quiet work. At completion, the gateway unsubscribes, stops the heartbeat and drains in-flight updates before finalizing the card and sending one result or decision question that @-mentions the run's original requester. Another member's steer does not replace that requester. Progress updates contain no mentions or separate timeline messages.

A failed progress update is reported in the topic and is not retried automatically. The task may still finish and return its result, but its reaction remains a failure mark. A failed result send emits `channel_error` and an operator log; Vela does not claim delivery or move the result to the main timeline. The first-reaction ≤2-second target and actual notification/rendering behavior require acceptance in a real Feishu group; offline tests establish ordering, not platform latency.

### Run controls

For top-level channel sessions and DMs, when a new text, post, image or file message arrives during the chat's run, Vela sends an interactive Card 2.0 (`schema: "2.0"`) in reply to that message (a normal send for DMs). Its buttons use `column_set` / `column` / `button` and `behaviors: [{ type: "callback", value }]`, matching the subscribed `card.action.trigger` event. The [Lark SDK's card troubleshooting notes](https://github.com/larksuite/node-sdk/blob/main/docs/channel.md#common-issues) describe the v1-payload mismatch that can prevent clicks from reaching that callback.

- **Queue (default)**: wait for the current run and reply, then answer the new message separately. Doing nothing has the same behavior; there is no extra waiting period.
- **Steer**: prepare the new message with its sender name and group context, then pass it to the current task with `streamingBehavior: 'steer'`. History excludes the active trigger and messages older than its `create_time`, since the session already has that context. Other messages at the same millisecond are retained; timestamps alone cannot order them. The current run sends one final reply to its original trigger, covering the original and steered inputs. The steered message does not start its own answer.
- **Stop**: abort the current run, discard this card's queued input and pending SDK inputs belonging to that run, and send `Stopped the current run.` to this card's triggering message. Other messages waiting in the gateway's default queue remain queued.

Any member of an enabled chat may use its controls, matching the shared owner session. In a DM enabled only through `owners`, the operator must be one of those owners. A callback must include the matching chat, an operator open_id, a recognized action and the opaque token issued for that card. The first valid choice wins. Repeated clicks and controls from a completed run or a previous process are ignored with an informational toast; they cannot affect a later run. Cards expire when Stop is accepted or the run settles.

The callback reserves the choice and returns its toast immediately; it does not wait for name/history APIs, model work or abort cleanup. If the run finishes during Steer preparation, the message remains in its default queue. A failed card send is logged and also leaves the message queued. Control cards do not count as answers when selecting the group-history boundary.

### Names and group context

Each incoming user message is prefixed with the sender's display name. Vela uses `contact.user.get` with `user_id_type: open_id`; names and fallback results are cached in memory (up to 1000 entries). If the contact API is unavailable, the name is empty, or the user is outside the app's contact data scope, the open_id is used instead. Restarting clears this cache. Slash-prefixed inputs are passed through verbatim to preserve extension commands, `/skill:` and prompt-template expansion; they skip name/context wrapping. Ordinary chat questions keep both.

For a top-level group @, after any earlier queued reply finishes, Vela fetches at most 50 recent chat-history messages. It takes text/post messages and attachment placeholders after this bot's last reply and before the triggering question, excludes the question itself and recalled messages, and injects them in chronological order into the same user message:

```text
[Chat since last reply]
Alice: Let's use blue.
Bob: Agreed.

[Question]
Alice: What should we do next?
```

The history window also supplies at most the four most recent images (including post images). In a group, send an image first, then @ the bot in a text message. Historical files appear only as `[file: <name>]` and are not downloaded.

With no earlier text, the input is just `Alice: What should we do next?`. If history cannot be fetched, Vela logs the failure and answers the named question alone. It does not claim the missing context was read. The API query is bounded to one page; older messages beyond that page are omitted. Feishu's chat-history endpoint returns thread roots, not all replies inside separate threads.

The most recent successful group reply is remembered in memory. History also identifies this application's own replies by app_id, so a restart can find the latest visible reply within the fetched page. Replies from a different bot are not this bot's context boundary.

### Feishu permissions

Use application (`tenant_access_token`) permissions. The bot must be enabled/published, be in the group, and have permission to speak. New permissions and contact data-scope changes must be published/approved in Feishu; Vela does not change them.

- Receive owner DMs: `im:message.p2p_msg:readonly`; receive group @ events: `im:message.group_at_msg:readonly`. Receiving untagged human replies in owned topics requires `im:message.group_msg` ([receive event](https://open.feishu.cn/document/server-docs/im-v1/message/events/receive)). This also delivers top-level messages, which Vela still drops unless they @ the bot.
- [Read group history](https://open.feishu.cn/document/server-docs/im-v1/message/list): `im:message.group_msg` **plus** one of `im:message` or `im:message:readonly` (legacy `im:message.history:readonly` also works). Mention-only event permission does not provide this history access.
- [Resolve display names](https://open.feishu.cn/document/server-docs/contact-v3/user/get): `contact:contact.base:readonly` for the contact API **and** `contact:user.base:readonly` for name fields. Include the relevant people in the app's contact data scope. No email/phone access is needed. Existing broader legacy contact permissions may already cover these fields.
- [Send replies](https://open.feishu.cn/document/server-docs/im-v1/message/reply), including interactive control cards (`msg_type: interactive`): `im:message:send_as_bot` or `im:message` (legacy `im:message:send` also works). No CardKit API or additional card-management permission is used. The separate `card.action.trigger` callback subscription above is required for buttons to work; message reception alone does not deliver clicks.
- [Create topics](https://open.feishu.cn/document/server-docs/im-v1/message/reply) and [forward into topics](https://open.feishu.cn/document/server-docs/im-v1/message/forward): `im:message:send_as_bot` covers both. Forwarding uses `receive_id_type: thread_id` and the platform thread ID; the root message ID is only the session identity.
- [Add/delete reactions](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create): `im:message.reactions:write_only`. Use the documented `OnIt`, `DONE` and `CrossMark` values, not an invented `EYES` value.
- [Update shared cards](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch): the existing `im:message:send_as_bot` permission qualifies; `im:message:update` is an alternative, not an additional required grant. Initial and updated cards must both set `config.update_multi: true`. The API permits 5 updates/second per message, cards up to 30 KB and updates within 14 days. Sending replies also has a group-wide 5 QPS limit shared by bots; API failures remain visible.
- Download message images and files: `im:resource`. The bot must be in the same chat as the message.
- [Identify this bot](https://open.feishu.cn/document/client-docs/bot-v3/obtain-bot-info): no additional API permission beyond enabled bot capability and the app's tenant token.

### Migration

This is a breaking channel change. A deployment that sets only `owners` now answers **only those owners' DMs**. Add each trusted group's chat_id to `chats` before expecting group replies. All members of that group receive full owner access; review the membership first.

Session ids change from `<channel>-<chat_id>-<sender_id>` to `<channel>-<chat_id>`. Old per-sender files remain on disk and are not automatically combined or resumed as shared history. The new chat starts a separate persisted session; keep old files if you need their transcripts. This avoids silently exposing a previous private sender history to the whole group. Existing core SDK sessions and roles are unchanged.

Custom `FeishuTransport` implementations must provide `getBotId`, `getSenderName`, `listMessages`, `listTopicMessages`, `reply`, `startTopic` and `forward`. `listTopicMessages(threadId, pageToken?)` returns `{ items, pageToken? }` in ascending creation order, with a next token only when more pages remain; use a thread container, page size 50 and no time filters. `listMessages` returns newest-first history with millisecond `create_time`; `reply` returns `{ messageId, createTime }` from the service's successful reply receipt. Sends/replies and API errors must reject, so the gateway reports failure instead of a successful reply.

`startTopic(messageId, task)` returns `{ messageId, createTime, rootId, threadId }` from the successful threaded reply. `forward(messageId, threadId)` returns `{ messageId, createTime }` from the successful forward. Missing required receipt fields and platform errors must reject; do not pretend an unthreaded send created a topic.

For attachments, implement `getResource(messageId, key, type)` returning a Node readable stream, where `type` is `image` or `file`. The default transport calls `im.messageResource.get` and uses `getReadableStream()`.

For run controls, implement `sendCard(chatId, card, replyToId?)` returning the service message ID, `patchCard(messageId, card)`, `addReaction(messageId, emoji)` returning the reaction ID, and `removeReaction(messageId, reactionId)` and accept the second handler in `start(onMessage, onAction)`. Send the Card 2.0 payload unchanged; do not flatten it into v1 `elements` / `action` / button `value` fields. Deliver the v2 callback body unchanged to `onAction` and return its `{ toast }` response to Feishu. Group cards use `replyToId`; DM cards use `chatId`. Card delivery must not be recorded as an ordinary text answer.

## Gateway lifecycle

On receiving a message, the gateway:

1. Selects the shared session from `(channel name, channelId)` or `(channel name, channelId, topic.rootId)`. Non-plain or long ids get a hash suffix to prevent collisions.
2. Serializes messages per session. Active topic inputs steer automatically; channel/DM inputs can offer Queue/Steer/Stop controls. Queued preparation and unsupported-message replies stay serialized, so a later reply cannot change the context boundary of an earlier question.
3. For topics, opens/resumes before preparation and rejects unowned input marked `requireExistingSession` without writing an empty file. Opens/resumes the selected persisted session and sets its role from `roleFor(message)`, defaulting to `owner`. A channel must reject untrusted chats **before** delivering them.
4. Acknowledges admitted input, subscribes to run events before prompting, and forwards them to the optional `showTopicControls` feedback handle. Cleans up and drains that handle before the terminal reply. Emits `channel_message`, prompts the session, and sends the last assistant text through `send({ channelId, recipientId, text, replyToId?, topic? })`. It emits `channel_reply` after success or `channel_error` after a failed turn/send. Empty answers and input handled by an extension do not resend an earlier answer.

Session save failures are logged at error level with the session id. After three consecutive reported save failures, new messages receive a reply that the session can't be saved, without running another prompt. A successful storage write resets the count, including an explicit SDK `await session.save()` after storage is repaired. Empty saves do not clear the count.

Before automatically closing an idle session, the gateway saves it. If that save fails, the same live session stays open with its pending history; the gateway does not start a periodic retry loop. While blocked, a new message first retries the pending save, and runs a prompt only after a real write succeeds. SDK callers reopening that id get the same session, so recovery does not create a competing history or another header. Channel activity after recovery restores normal idle cleanup. SDK-only recovery clears the count but leaves the session open until the next channel activity or an explicit close/dispose, so a save cannot schedule a close during SDK work. Failed sessions retain memory until recovery or disposal. Explicit SDK `close()`/`dispose()` and writes made by shutdown hooks keep their existing semantics; they can still discard unsaved data. In-session retries are unchanged.

Channel sessions have no UI: permissions set to `ask` are rejected, and extension UI calls fall back to events. Sessions close after 10 idle minutes and resume on the next message; `createVela({ channelIdleMs })` changes that wait (`0` closes after each completed queue). Running sessions or queued chats are not closed prematurely.

**SDK:** `await vela.startChannels()` starts registered channels. `vela.channels()` lists them. `vela.dispose()` aborts running sessions, waits for pending work and stops channels. A failed channel `start()` is logged without stopping other channels.

**CLI:** channels start with interactive mode, and stop on exit. Incoming messages, replies and errors appear in the terminal; channel tool calls are not displayed there. Print, JSON and RPC modes do not start channels. `/channel` lists them.

## Writing a channel

Register a `ChannelDefinition` with `vela.registerChannel()` from an extension. It has `name`, `description`, `start()`, `stop()`, `send(message)`, optional `onMessage(handler)` and optional `roleFor(message)`. The incoming handler returns `void | Promise<void>`; await it when preprocessing must wait until that message and its reply finish.

Optional `prepareMessage(message, activeMessage?)` performs asynchronous preprocessing when the gateway is ready to run the input; return `undefined` for input handled without a prompt. On Steer, the optional second argument is the active trigger already in the shared session, so a channel can exclude previously supplied context. Ordinary queued messages receive no active trigger. Existing one-argument implementations remain valid. Optional `showRunControls(message, { signal, choose })` can present the queued input's choices. `choose('queue' | 'steer' | 'stop')` synchronously reserves a choice and returns false after expiry or a prior choice. The signal aborts with the original run's lifetime; remove any stored controls then. Do not serialize incoming delivery behind the preceding handler if the channel needs to offer controls during that run.

Incoming messages contain `channelId`, `senderId`, `senderName`, `text`, optional `images: ImageContent[]`, optional `replyToId` and optional `raw`. The sender identifies the speaker, not a separate session. Outgoing `replyToId` identifies the service message to answer; a custom transport decides how to use it.

Custom channels can still choose an SDK role using `roleFor`, but switching roles does not isolate the shared transcript. Do not mix untrusted and trusted participants in one chat and assume a guest role hides the earlier owner turns. Enforce your chat boundary before invoking the incoming handler.

[echo-channel.ts](../examples/extensions/echo-channel.ts) is an offline registration example. The core SDK's independent `vela.session(id, { role })` model remains available for callers that need explicitly separate sessions.

Channel events keep their existing shape: `channel_message` has `channel`, `senderId`, `senderName`, `text`; `channel_reply` has `channel`, `recipientId`, `text`; `channel_error` has `channel`, `senderId`, `error`, `aborted`. Subscribers also receive the session id.

Topic-capable channels can supply `IncomingMessage.topic: { rootId, threadId }` and `requireExistingSession: true` for untagged input that must not establish a new conversation. The gateway performs that admission before `prepareMessage` and sets `isNewTopic` from the saved-session probe (false for active steers); active topic inputs steer automatically. `OutgoingMessage.topic` preserves topic identity for reply bookkeeping. Optional `showTopicControls(message, { signal, stop })` creates one control per run; `stop()` reserves cancellation synchronously and expired callbacks return false. Keep per-message Queue/Steer controls in `showRunControls` for non-topic conversations.

Optional `connect(runtime)` receives gateway operations: `context(sessionId)` reads the current trigger, `topics(chatId)` lists observed owned topics, and `dispatch(sourceSessionId, message)` independently enqueues a handoff and suppresses the source run’s duplicate final reply. Optional `sessionOptions(message)` selects tool permissions when that session is first opened. These operations do not introduce a recovery index or change core session APIs.
