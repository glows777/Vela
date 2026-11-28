import type { Socket } from 'node:net'
import type {
  AuthEvent,
  AuthInteraction,
  AuthPrompt,
  LoginOptions,
} from '../providers/auth/types.ts'
import type { LocalVelaRuntime } from '../runtime-sdk-types.ts'
import { safeWriteWire } from './protocol.ts'

export interface PendingLoginClient {
  controller: AbortController
  prompts: Map<
    number,
    {
      resolve: (value: string) => void
      reject: (err: Error) => void
      cleanup?: () => void
    }
  >
}

export interface LoginCapableClient {
  socket: Socket
  activeLogins: Map<number, PendingLoginClient>
  preCancelledLogins: Set<number>
}

export function createAuthLoginHandler(
  runtime: LocalVelaRuntime,
  nextPromptId: () => number,
) {
  return async (
    p: {
      loginId: number
      provider: string
      method: 'oauth' | 'api_key'
      options?: Omit<LoginOptions, 'getDeviceId'> & { deviceId?: string }
    },
    client: LoginCapableClient,
  ) => {
    const controller = new AbortController()
    if (client.preCancelledLogins.delete(p.loginId)) {
      controller.abort(new DOMException('Cancelled', 'AbortError'))
    }
    const prompts = new Map<
      number,
      {
        resolve: (value: string) => void
        reject: (err: Error) => void
        cleanup?: () => void
      }
    >()
    client.activeLogins.set(p.loginId, { controller, prompts })
    const interaction: AuthInteraction = {
      signal: controller.signal,
      notify: (event: AuthEvent) => {
        safeWriteWire(client.socket, {
          type: 'auth_event',
          loginId: p.loginId,
          event,
        })
      },
      prompt: (prompt: AuthPrompt) => {
        const promptId = nextPromptId()
        return new Promise<string>((resolve, reject) => {
          const { signal: promptSignal, ...wirePrompt } = prompt
          let settled = false
          const cleanup = () => {
            controller.signal.removeEventListener('abort', onLoginAbort)
            promptSignal?.removeEventListener('abort', onPromptAbort)
          }
          const settle = (err: Error | undefined, value?: string) => {
            if (settled) return
            settled = true
            prompts.delete(promptId)
            cleanup()
            if (err !== undefined) reject(err)
            else resolve(value ?? '')
          }
          const onLoginAbort = () => {
            settle(new DOMException('Login cancelled', 'AbortError'))
          }
          const onPromptAbort = () => {
            safeWriteWire(client.socket, {
              type: 'auth_prompt_cancel',
              loginId: p.loginId,
              promptId,
            })
            settle(new DOMException('Prompt cancelled', 'AbortError'))
          }
          if (controller.signal.aborted) {
            onLoginAbort()
            return
          }
          if (promptSignal?.aborted) {
            onPromptAbort()
            return
          }
          prompts.set(promptId, {
            resolve: (value) => settle(undefined, value),
            reject: (err) => settle(err),
            cleanup,
          })
          controller.signal.addEventListener('abort', onLoginAbort, {
            once: true,
          })
          promptSignal?.addEventListener('abort', onPromptAbort, { once: true })
          safeWriteWire(client.socket, {
            type: 'auth_prompt',
            loginId: p.loginId,
            promptId,
            prompt: wirePrompt,
          })
        })
      },
    }
    const { deviceId, ...restOptions } = p.options ?? {}
    const resolvedLoginOptions: LoginOptions = {
      ...restOptions,
      ...(typeof deviceId === 'string' && deviceId.length > 0
        ? { getDeviceId: () => deviceId }
        : {}),
    }
    try {
      await runtime.login(
        p.provider,
        p.method,
        interaction,
        resolvedLoginOptions,
      )
      return { ok: true }
    } finally {
      for (const pending of [...prompts.values()]) {
        pending.reject(new DOMException('Login finished', 'AbortError'))
      }
      prompts.clear()
      client.activeLogins.delete(p.loginId)
    }
  }
}
