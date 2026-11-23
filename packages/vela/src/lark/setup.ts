import { type LarkTransport, larkChatName, larkTransport } from './transport.ts'

/** Wait for a human to mention this bot in a group on the temporary connection. */
export async function discoverLarkGroup(
  transport: LarkTransport,
  signal?: AbortSignal,
  excludedChatIds?: ReadonlySet<string>,
): Promise<{ chatId: string; name?: string }> {
  if (signal?.aborted) throw new Error('Lark setup cancelled')
  const botId = await new Promise<string>((resolve, reject) => {
    const abort = () => reject(new Error('Lark setup cancelled'))
    signal?.addEventListener('abort', abort, { once: true })
    transport.getBotId().then(
      (id) => {
        signal?.removeEventListener('abort', abort)
        resolve(id)
      },
      (error) => {
        signal?.removeEventListener('abort', abort)
        reject(error)
      },
    )
  })
  return new Promise((resolve, reject) => {
    let selected = false
    const abort = () => reject(new Error('Lark setup cancelled'))
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
    transport
      .start(
        (event) => {
          const message = event.message
          if (
            selected ||
            event.sender.sender_type !== 'user' ||
            message.chat_type !== 'group' ||
            excludedChatIds?.has(message.chat_id) ||
            !message.mentions?.some((item) => item.id?.open_id === botId)
          )
            return
          selected = true
          const chatId = message.chat_id
          // A slow display-only lookup must not block confirmation of the ID.
          let timer: ReturnType<typeof setTimeout> | undefined
          const deadline = new Promise<undefined>((finish) => {
            timer = setTimeout(() => finish(undefined), 2_000)
          })
          void Promise.race([larkChatName(transport, chatId), deadline]).then(
            (name) => {
              clearTimeout(timer)
              signal?.removeEventListener('abort', abort)
              resolve(name ? { chatId, name } : { chatId })
            },
          )
        },
        () => ({ toast: { type: 'info', content: 'Setup in progress' } }),
      )
      .catch((error) => {
        if (selected) return
        signal?.removeEventListener('abort', abort)
        reject(error)
      })
  })
}

/** Validate fresh credentials, then expose a short-lived discovery connection. */
export async function connectLarkSetup(
  appId: string,
  appSecret: string,
  signal?: AbortSignal,
) {
  const response = await fetch(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal,
    },
  )
  const result = (await response.json()) as {
    code?: number
    msg?: string
    tenant_access_token?: string
  }
  if (!response.ok || result.code !== 0 || !result.tenant_access_token)
    throw new Error(
      `Lark ${result.code ?? response.status}: ${result.msg ?? 'credential verification failed'}`,
    )
  const controller = new AbortController()
  const discoverySignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal
  let rejectConnection: ((error: Error) => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const transport = larkTransport(
    appId,
    appSecret,
    true,
    (error) => rejectConnection?.(error),
    () => clearTimeout(timer),
  )
  return {
    waitForMention: (excludedChatIds?: ReadonlySet<string>) =>
      Promise.race([
        new Promise<never>((_, reject) => {
          rejectConnection = reject
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'Lark connection did not become ready; check long connection settings and retry',
                ),
              ),
            30000,
          )
        }),
        discoverLarkGroup(transport, discoverySignal, excludedChatIds),
      ]),
    send: (chatId: string, text: string) => transport.send(chatId, text),
    stop: () => {
      clearTimeout(timer)
      controller.abort()
      transport.stop()
    },
  }
}
