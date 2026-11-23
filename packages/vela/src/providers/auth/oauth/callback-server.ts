// Loopback OAuth redirect handler, adapted from pi-mono (packages/ai/src/auth/oauth/callback-server.ts, MIT).
import { createServer, type ServerResponse } from 'node:http'
import type { AuthInteraction } from '../types.ts'

export interface CallbackServerOptions<T> {
  /** Provider name shown on the browser page */
  providerName: string
  host: string
  /** `0` picks a free port */
  port: number
  path: string
  /** Expected `state`; omit when the provider sends none */
  state?: string
  /** Finishes the sign-in with the callback's query before the browser page is sent, so the page can show failures */
  complete: (params: URLSearchParams) => Promise<T>
  signal: AbortSignal
  timeoutMs?: number
}

export interface CallbackServer<T> {
  redirectUri: string
  /** The result of `complete`, or undefined after cancel() */
  wait(): Promise<T | undefined>
  cancel(): void
  close(): void
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Sends a small HTML page; resolves once it is flushed, so closing the server afterwards cannot cut it off */
function sendPage(
  response: ServerResponse,
  status: number,
  title: string,
  detail = '',
): Promise<void> {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  })
  return new Promise((resolve) => {
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Vela</title><body style="font-family:system-ui;margin:3em"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p></body>`,
      () => resolve(),
    )
    response.once('close', () => resolve())
  })
}

export async function startCallbackServer<T>(
  options: CallbackServerOptions<T>,
): Promise<CallbackServer<T>> {
  const { providerName, signal } = options
  if (signal.aborted) throw new Error('Login cancelled')
  let resolveWait: (value: T | undefined) => void = () => {}
  let rejectWait: (error: Error) => void = () => {}
  const waitPromise = new Promise<T | undefined>((resolve, reject) => {
    resolveWait = resolve
    rejectWait = reject
  })
  waitPromise.catch(() => undefined)
  let claimed = false
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const finish = (result: { value: T | undefined } | { error: Error }) => {
    if (settled) return
    settled = true
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    if ('error' in result) rejectWait(result.error)
    else resolveWait(result.value)
  }
  const onAbort = () => finish({ error: new Error('Login cancelled') })

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (request.method !== 'GET' || url.pathname !== options.path)
        return sendPage(response, 404, 'Callback route not found.')
      if (claimed || settled)
        return sendPage(response, 409, 'This sign-in has already been handled.')
      const error = url.searchParams.get('error')
      if (error) {
        const description = url.searchParams.get('error_description') ?? error
        claimed = true
        await sendPage(
          response,
          400,
          `${providerName} authorization failed.`,
          description,
        )
        return finish({
          error: new Error(
            `${providerName} authorization failed: ${description}`,
          ),
        })
      }
      if (
        options.state !== undefined &&
        url.searchParams.get('state') !== options.state
      )
        return sendPage(response, 400, 'State mismatch.')
      if (!url.searchParams.get('code'))
        return sendPage(response, 400, 'Missing authorization code.')
      claimed = true
      try {
        const value = await options.complete(url.searchParams)
        await sendPage(
          response,
          200,
          `Signed in to ${providerName}. You can close this page.`,
        )
        finish({ value })
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error))
        await sendPage(
          response,
          502,
          `${providerName} sign-in failed.`,
          failure.message,
        )
        finish({ error: failure })
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('OAuth callback server did not bind to TCP')
  }
  server.on('error', (error) => finish({ error }))
  signal.addEventListener('abort', onAbort, { once: true })
  if (options.timeoutMs !== undefined)
    timer = setTimeout(
      () => finish({ error: new Error(`${providerName} sign-in timed out`) }),
      options.timeoutMs,
    )
  return {
    redirectUri: `http://${options.host}:${address.port}${options.path}`,
    wait: () => waitPromise,
    cancel: () => {
      if (!claimed) finish({ value: undefined })
    },
    close: () => {
      finish({ error: new Error('OAuth callback server closed') })
      server.close()
      // Browsers open spare connections; one left attached here would swallow a later login's callback (pi)
      server.closeAllConnections()
    },
  }
}

/**
 * Waits for the browser callback, or for the user to paste the redirect URL when the browser cannot reach the
 * loopback server (a remote machine over SSH). Whichever comes first wins; the other is cancelled.
 */
export async function waitForCallbackOrPaste<T>(
  interaction: AuthInteraction,
  callback: CallbackServer<T>,
  prompt: { message: string; placeholder: string },
): Promise<{ type: 'callback'; value: T } | { type: 'manual'; input: string }> {
  const manualAbort = new AbortController()
  let manualError: Error | undefined
  const manual = interaction
    .prompt({ type: 'manual_code', ...prompt, signal: manualAbort.signal })
    .then((input) => {
      callback.cancel()
      return input
    })
    .catch((error: unknown) => {
      manualError = error instanceof Error ? error : new Error(String(error))
      callback.cancel()
      return undefined
    })
  try {
    const value = await callback.wait()
    if (manualError) throw manualError
    if (value !== undefined) return { type: 'callback', value }
    const input = await manual
    if (manualError) throw manualError
    return { type: 'manual', input: input ?? '' }
  } finally {
    manualAbort.abort()
  }
}
