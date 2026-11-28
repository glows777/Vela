import type { DaemonServerHandle, StartDaemonServerOptions } from './server.ts'

export { type ConnectRuntimeOptions, connectRuntime } from './client.ts'
export {
  type DaemonCommandOverride,
  type DaemonLifecycleOptions,
  ensureDaemonRunning,
  getDaemonStatus,
  startDaemon,
  stopDaemon,
} from './launcher.ts'
export { DaemonAlreadyRunningError } from './owner-lock.ts'
export { resolveDaemonPaths } from './paths.ts'
export {
  DAEMON_PROTOCOL_VERSION,
  type DaemonHello,
  type DaemonStatus,
} from './protocol.ts'
export type { DaemonServerHandle, StartDaemonServerOptions }

export async function startDaemonServer(
  options: StartDaemonServerOptions = {},
): Promise<DaemonServerHandle> {
  const { startDaemonServer: start } = await import('./server.ts')
  return start(options)
}
