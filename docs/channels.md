# Channels

A channel brings messages from outside into Vela, such as chat messages sent to a bot, and sends the model's replies back. Channels are specific to Vela; pi has no equivalent.

Each sender gets their own session. Sessions of different senders run concurrently and share the Vela's tools and extensions, but each has its own history, role and run lock. Messages from one sender are handled one at a time: a second message waits until the reply to the first has been sent.

Channel senders are `guest` by default. A guest's model sees only `tool_search`, `rag_search` and `web_search`: it cannot read or write files, run commands, use the owner's memory or run extension commands. See [Security](security.md) for what this boundary does and does not cover.

## How a message is handled

When a channel delivers a message:

1. Vela picks the session id from the channel name and sender id, for example `feishu-ou_123`. Ids with other characters are sanitized and suffixed with a hash, so different senders never share a session.
2. It sets the session's role from the channel's `roleFor(message)`, or `guest` when the channel has no `roleFor`. The role is checked again on every message, so changing the owner list takes effect on the next message.
3. On the sender's first message since startup, the session is resumed from storage, so history survives restarts when Vela has a `dataDir`.
4. It emits `channel_message`, runs the turn, and sends the text of the final assistant message back through the channel's `send()` to the same `channelId`. It then emits `channel_reply`, or `channel_error` if the turn or the send failed.

Channel sessions have no UI. A tool whose permission is `ask` is rejected, and extension UI calls fall back to events (see [Extensions](extensions.md)).

## Writing a channel

An extension registers a channel with `vela.registerChannel()`:

```ts
import type { IncomingMessage, VelaExtension } from '@glows777/vela'

const myChannel: VelaExtension = (vela) => {
  let deliver: ((msg: IncomingMessage) => void) | undefined
  vela.registerChannel({
    name: 'my-chat',
    description: 'My chat service',
    onMessage: (handler) => {
      deliver = handler
    },
    start: async () => {
      // connect, then call deliver({ channelId, senderId, senderName, text }) for each message
    },
    stop: async () => {
      // disconnect
    },
    send: async ({ channelId, recipientId, text }) => {
      // post text to the conversation channelId
    },
    roleFor: (msg) => (msg.senderId === 'me' ? 'owner' : 'guest'),
  })
}

export default myChannel
```

| Member | Description |
|---|---|
| `name` | Channel name, used in session ids and events |
| `description` | Shown by `/channel` |
| `start()` | Connect and begin receiving; called by `vela.startChannels()` |
| `stop()` | Disconnect; called by `vela.dispose()` after running channel sessions are aborted |
| `send(message)` | Deliver a reply: `{ channelId, recipientId, text }` |
| `onMessage(handler)` | Optional. Called once at registration with the handler to call for each incoming message |
| `roleFor(message)` | Optional. The sender's role: `owner`, `collaborator` or `guest`. Default `guest` |

An incoming message has `channelId` (the conversation to reply to), `senderId` (who sent it; this selects the session), `senderName`, `text`, and optionally `raw` (the original payload).

A failing `start()` is logged and does not stop other channels from starting.

### Events

Channel sessions emit these events, which `vela.subscribe()` receives along with the session id:

| Event | Fields |
|---|---|
| `channel_message` | `channel`, `senderId`, `senderName`, `text` |
| `channel_reply` | `channel`, `recipientId`, `text` |
| `channel_error` | `channel`, `senderId`, `error`, `aborted` |

### Example

[examples/extensions/echo-channel.ts](../examples/extensions/echo-channel.ts) is a channel that sends and receives in memory: `receive(senderId, text)` simulates an incoming message and `sent` collects the replies. It runs offline with the faux model:

```ts
import { createVela } from '@glows777/vela'
import { createFauxModel, fauxText } from '@glows777/vela/testing'
import { echoChannel } from './examples/extensions/echo-channel.ts'

const channel = echoChannel({ owners: ['alice'] })
const vela = createVela({
  model: createFauxModel({
    responses: [fauxText('Hello, guest'), fauxText('Hello, owner')],
  }),
  extensions: [channel.extension],
})
await vela.ready()
await vela.startChannels()

const done = new Promise<void>((resolve) => {
  let replies = 0
  vela.subscribe((event, sessionId) => {
    if (event.type !== 'channel_reply') return
    console.log(sessionId, vela.session(sessionId).role, event.text)
    if (++replies === 2) resolve()
  })
})
channel.receive('bob', 'hi')
channel.receive('alice', 'hi')
await done
await vela.dispose()
// echo-bob guest Hello, guest
// echo-alice owner Hello, owner
```

## Running channels

**SDK.** Call `await vela.startChannels()` after `vela.ready()`. `vela.channels()` lists the registered channels. `vela.dispose()` aborts running channel sessions, waits for them, and stops the channels.

**CLI.** Channels start when interactive mode starts, and stop when it exits. Each incoming message, reply (first 80 characters) and error is shown as one line in the terminal; the channel session's tool calls are not shown. Print, JSON and RPC modes do not start channels. `/channel` lists the registered channels.

## Feishu

The built-in `feishu` extension connects a Feishu (Lark) bot through Feishu's long connection (WebSocket), so Vela needs no public URL. It is loaded by default in the CLI.

1. In the Feishu developer console, create a custom app, enable the bot capability, and grant it permission to receive and send messages.
2. Under events, choose long-connection mode and subscribe to `im.message.receive_v1`.
3. Give Vela the app id and secret, and the `open_id`s of the people who should be owners:

   ```sh
   export FEISHU_APP_ID=cli_xxx
   export FEISHU_APP_SECRET=xxx
   export FEISHU_OWNERS=ou_aaa,ou_bbb
   ```

   or in [settings](settings.md):

   ```json
   {
     "extensionConfig": {
       "feishu": {
         "appId": "cli_xxx",
         "appSecret": "$FEISHU_APP_SECRET",
         "owners": ["ou_aaa", "ou_bbb"]
       }
     }
   }
   ```

4. Start `vela` in interactive mode and keep it running.

Behavior:

- Only text messages are handled. `@` mentions of the bot are removed from the text.
- The sender's `open_id` is the sender id, so each person has one session across all chats they use, including group chats. The reply goes to the chat the message came from.
- Senders in `owners` are `owner`; everyone else is `guest`.
- Without an app id or secret the channel logs a warning and does not connect.

With the SDK: `feishu({ appId, appSecret, owners })`, then `vela.startChannels()`. See [Built-in extensions](built-in-extensions.md#feishu).
