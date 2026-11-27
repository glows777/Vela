import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startDaemonServer } from '@glows777/vela'
import {
  settingsTransport,
  verifySettingsCredentials,
} from './settings-transport.ts'
import { fakeLark } from './testing/lark.ts'

function parseCliArgs(argv: readonly string[]): {
  agentDir?: string
  socketPath?: string
} {
  let agentDir: string | undefined
  let socketPath: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--agent-dir') {
      agentDir = argv[i + 1]
      i += 1
    } else if (arg?.startsWith('--agent-dir=')) {
      agentDir = arg.slice('--agent-dir='.length)
    } else if (arg === '--socket') {
      socketPath = argv[i + 1]
      i += 1
    } else if (arg?.startsWith('--socket=')) {
      socketPath = arg.slice('--socket='.length)
    }
  }
  return { agentDir, socketPath }
}

async function resolveDefaultModel() {
  const ref = process.env.VELA_MODEL?.trim()
  if (!ref) return undefined
  if (ref === 'mock') {
    const { createFauxModel } = await import('@glows777/vela/testing')
    return createFauxModel()
  }
  if (ref.startsWith('faux:')) {
    const scenarioPath = ref.slice('faux:'.length)
    const { createFauxModel, readFauxScenario } = await import(
      '@glows777/vela/testing'
    )
    let lastRaw = readFileSync(scenarioPath, 'utf8')
    let current = createFauxModel(await readFauxScenario(scenarioPath))
    const ensureFresh = () => {
      try {
        const nextRaw = readFileSync(scenarioPath, 'utf8')
        if (nextRaw !== lastRaw) {
          const parsed = JSON.parse(nextRaw)
          if (parsed && Array.isArray(parsed.responses)) {
            lastRaw = nextRaw
            current = createFauxModel(parsed)
          }
        }
      } catch {
        // Keep the previous scenario if the test file is mid-write.
      }
      return current
    }
    return {
      ...current,
      doGenerate: (opts: unknown) => ensureFresh().doGenerate(opts),
      doStream: (opts: unknown) => ensureFresh().doStream(opts),
    } as typeof current
  }
  return undefined
}

async function main(): Promise<void> {
  const { agentDir, socketPath } = parseCliArgs(process.argv.slice(2))
  const defaultModel = await resolveDefaultModel()
  const fakeMode = process.env.VELA_DESKTOP_LARK === 'fake'
  const fixtureDir = process.env.VELA_DESKTOP_LARK_DIR?.trim()
  const larkTransport =
    fakeMode && fixtureDir ? fakeLark(fixtureDir) : undefined

  await new Promise<void>((resolve) => {
    void startDaemonServer({
      ...(agentDir ? { agentDir } : {}),
      ...(socketPath ? { socketPath } : {}),
      hostEnv: process.env,
      registerSignalHandlers: true,
      onClosed: () => resolve(),
      ...(defaultModel ? { defaultModel } : {}),
      ...(larkTransport ? { larkTransport } : {}),
      ...(fakeMode && !fixtureDir
        ? {
            onCreateLarkTransport: ({ appId, appSecret }) =>
              settingsTransport(appId, appSecret),
            onVerifyLarkCredentials: verifySettingsCredentials,
          }
        : {}),
      ...(fakeMode && fixtureDir
        ? {
            onCreateLarkDiscoveryTransport: async () =>
              fakeLark(join(fixtureDir, 'discovery')),
          }
        : {}),
    }).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error)
      process.stderr.write(`${msg}\n`)
      process.exit(1)
    })
  })
}

main().catch((error) => {
  const msg = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${msg}\n`)
  process.exit(1)
})
