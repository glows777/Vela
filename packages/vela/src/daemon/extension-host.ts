import { registerExtensionHostModules } from '../driver/config/extensions.ts'

/**
 * Registers `@glows777/vela`, `@glows777/vela/extension-api`, and `zod` for in-process
 * single-file bundles (CLI and Electron packaged `daemon.mjs`) lacking sibling files.
 */
export function registerBuiltinExtensionHostModules(
  extraDaemonExports?: Record<string, unknown>,
): void {
  registerExtensionHostModules({
    '@glows777/vela/extension-api': () => import('../extension-api.ts'),
    '@glows777/vela': async () => {
      const [
        client,
        launcher,
        ownerLock,
        localExec,
        lark,
        loadCfg,
        authStore,
        runtimeMod,
        runtimeSdk,
        loggerMod,
      ] = await Promise.all([
        import('./client.ts'),
        import('./launcher.ts'),
        import('./owner-lock.ts'),
        import('../driver/execution/local.ts'),
        import('../lark/index.ts'),
        import('../load-config.ts'),
        import('../providers/auth/store.ts'),
        import('../runtime/index.ts'),
        import('../runtime-sdk.ts'),
        import('../shared/logger.ts'),
      ])
      return {
        // 18 converged root runtime symbols (matching packages/vela/src/index.ts)
        createRuntime: runtimeSdk.createRuntime,
        connectRuntime: client.connectRuntime,
        getDaemonStatus: launcher.getDaemonStatus,
        startDaemon: launcher.startDaemon,
        stopDaemon: launcher.stopDaemon,
        DaemonAlreadyRunningError: ownerLock.DaemonAlreadyRunningError,
        EnvironmentRegistry: runtimeMod.EnvironmentRegistry,
        RuntimeWebhookReceiver: runtimeMod.RuntimeWebhookReceiver,
        createLarkChannelAdapter: lark.createLarkChannelAdapter,
        LarkChannelAdapter: lark.LarkChannelAdapter,
        larkConfig: lark.larkConfig,
        loadConfig: loadCfg.loadConfig,
        loadModels: loadCfg.loadModels,
        fileCredentialStore: authStore.fileCredentialStore,
        memoryCredentialStore: authStore.memoryCredentialStore,
        createLocalExecutionEnv: localExec.createLocalExecutionEnv,
        silentLogger: loggerMod.silentLogger,
        ...extraDaemonExports,
      }
    },
    zod: () => import('zod'),
  })
}
