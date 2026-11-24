import { join } from 'node:path'
import type { VelaSettings } from '../../config/index.ts'
import type { ExecutionEnv } from '../execution/types.ts'
import {
  discoverExtensions,
  type ExtensionEntry,
  resolveExtensionEntries,
} from './extension-discovery.ts'

/** Descriptors only; callers import code only after selecting or creating a project scope. */
export function loadProjectExtensionEntries(
  environment: Pick<ExecutionEnv, 'id' | 'cwd'>,
  options: {
    trusted: boolean
    agentDir?: string
    /** The pinned project-only settings, not merged startup or user settings. */
    settings: VelaSettings
    signal?: AbortSignal
  },
): { entries: ExtensionEntry[]; diagnostics: string[] } {
  options.signal?.throwIfAborted()
  if (!options.trusted) return { entries: [], diagnostics: [] }
  if (environment.id !== 'node:local')
    return {
      entries: [],
      diagnostics: [
        `Skipped project extensions at ${environment.cwd}: workspace code from ${environment.id} cannot execute on the host.`,
      ],
    }
  const projectDir = join(environment.cwd, '.vela')
  if (projectDir === options.agentDir) return { entries: [], diagnostics: [] }
  // Built-in activation belongs to the frontend composition, not filesystem imports.
  const entries = (options.settings.extensions ?? []).filter(
    (entry) => !/^[+-]?builtin:/.test(entry),
  )
  return {
    entries: resolveExtensionEntries(
      entries,
      discoverExtensions(join(projectDir, 'extensions')),
    ),
    diagnostics: [],
  }
}
