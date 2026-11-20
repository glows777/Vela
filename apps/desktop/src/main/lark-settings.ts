import { saveLarkSection } from '@glows777/vela'
import { connectLarkSetup } from '@glows777/vela-lark'
import type { LarkSetup, SettingsState } from '../shared/bridge.ts'

/** SDK errors may contain configuration values. Only fixed diagnostic text crosses IPC. */
export function larkStartupDiagnostic(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : ''
  if (message === 'Duplicate Lark chat id')
    return 'Lark could not start. Remove duplicate chat IDs from extensionConfig.lark.chats in settings.json.'
  if (message.startsWith('Unknown Lark tool '))
    return 'Lark could not start. Check the tools for enabled chats in settings.json.'
  if (message.startsWith('Unknown Lark thinking level '))
    return 'Lark could not start. Check the thinking levels for enabled chats in settings.json.'
  return 'Lark could not start. Check extensionConfig.lark in settings.json, then restart the app.'
}

export function larkState(
  raw: Record<string, unknown>,
  section: Record<string, unknown>,
  loaded: boolean,
  startupError?: string,
): SettingsState['lark'] {
  const entries =
    typeof section.chats === 'string' ? section.chats.split(',') : section.chats
  const chats = Array.isArray(entries)
    ? entries
        .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
        .filter((id): id is string => typeof id === 'string')
        .map((id) => id.trim())
        .filter(Boolean)
    : []
  return {
    appId: typeof section.appId === 'string' ? section.appId : '',
    appSecretSaved:
      typeof section.appSecret === 'string' && !!section.appSecret,
    chats: [...new Set(chats)],
    envExpression: typeof raw.chats === 'string' && raw.chats.includes('$'),
    runInApp: section.runInApp !== false,
    loaded,
    ...(startupError ? { startupError } : {}),
  }
}

export async function verifyCredentials(id: string, secret: string) {
  const connection = await connectLarkSetup(
    id,
    secret,
    AbortSignal.timeout(30_000),
  )
  connection.stop()
}

/** Only the approved fields reach the shared writer, even for an untyped IPC caller. */
export async function writeLark(
  agentDir: string,
  section: Record<string, unknown>,
  input: LarkSetup,
  verify: (id: string, secret: string) => Promise<void>,
  checkIdle: () => void,
) {
  checkIdle()
  if ('runInApp' in input && typeof input.runInApp === 'boolean')
    return saveLarkSection({ agentDir, runInApp: input.runInApp })
  if ('removeChat' in input && typeof input.removeChat === 'string')
    return saveLarkSection({
      agentDir,
      removeChat: input.removeChat,
      env: process.env,
    })
  if (
    !('appId' in input) ||
    typeof input.appId !== 'string' ||
    (input.appSecret !== undefined && typeof input.appSecret !== 'string')
  )
    throw new Error('Invalid Lark settings')
  const appId = input.appId.trim()
  const secret = input.appSecret ?? section.appSecret
  if (!appId || typeof secret !== 'string' || !secret)
    throw new Error('Enter the Lark app ID and secret.')
  try {
    await verify(appId, secret)
  } catch {
    // Provider exceptions may include request bodies, headers, or transformed credentials.
    throw new Error(
      'Could not verify Lark credentials. Check the app ID and secret and try again.',
    )
  }
  checkIdle()
  return saveLarkSection({
    agentDir,
    ...(appId === section.appId ? {} : { appId }),
    appSecret: input.appSecret,
  })
}
