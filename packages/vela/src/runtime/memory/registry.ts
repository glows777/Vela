import { join, resolve } from 'node:path'
import type { VelaLogger } from '../../shared/logger.ts'
import { assertSafePathSegment } from '../driver.ts'
import { MemoryStore } from './store.ts'

export interface MemoryDirs {
  localDir: string
  globalDir: string
  isProject: boolean
}

/**
 * Resolves memory store directories for a Runtime session:
 * - Project sessions store notes at `<agentDir>/projects/<projectId>/memory` plus read-only global `<agentDir>/memory`.
 * - Standalone/chat sessions store notes directly in `<agentDir>/memory`.
 */
export function resolveMemoryDirs(
  agentDir: string,
  projectId?: string | null,
): MemoryDirs {
  const globalDir = join(agentDir, 'memory')
  if (projectId) {
    assertSafePathSegment(projectId, 'projectId')
    return {
      localDir: join(agentDir, 'projects', projectId, 'memory'),
      globalDir,
      isProject: true,
    }
  }
  return {
    localDir: globalDir,
    globalDir,
    isProject: false,
  }
}

/**
 * Process-local singleton cache of `MemoryStore` instances keyed by canonicalized memory directory path.
 * Ensures all sessions sharing a project or global memory directory reuse the same `MemoryStore`.
 */
export class MemoryRegistry {
  private readonly stores = new Map<string, MemoryStore>()

  constructor(private readonly logger?: VelaLogger) {}

  get(memoryDir: string, projectDir = '.'): MemoryStore {
    const normalizedDir = resolve(memoryDir)
    const normalizedProject = projectDir === '.' ? '.' : resolve(projectDir)
    const key = JSON.stringify([normalizedDir, normalizedProject])
    let store = this.stores.get(key)
    if (!store) {
      store = new MemoryStore(normalizedDir, this.logger, normalizedProject)
      this.stores.set(key, store)
    }
    return store
  }

  global(agentDir: string, projectDir = '.'): MemoryStore {
    return this.get(resolveMemoryDirs(agentDir, null).globalDir, projectDir)
  }

  forSession(
    agentDir: string,
    projectId?: string | null,
    projectDir = '.',
  ): { local: MemoryStore; global: MemoryStore; isProject: boolean } {
    const dirs = resolveMemoryDirs(agentDir, projectId)
    const global = this.get(dirs.globalDir, dirs.isProject ? '.' : projectDir)
    const local = dirs.isProject ? this.get(dirs.localDir, projectDir) : global
    return { local, global, isProject: dirs.isProject }
  }
}
