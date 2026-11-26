export { type ConnectRuntimeOptions, connectRuntime } from './client.ts'
export {
  ensureDaemonRunning,
  getDaemonStatus,
  startDaemon,
  stopDaemon,
} from './launcher.ts'
export { resolveDaemonPaths } from './paths.ts'
export { DAEMON_PROTOCOL_VERSION, type DaemonStatus } from './protocol.ts'
