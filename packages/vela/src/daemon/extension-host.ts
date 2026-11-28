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
    '@glows777/vela': () =>
      Promise.all([
        import('./client.ts'),
        import('./launcher.ts'),
        import('./owner-lock.ts'),
        import('./paths.ts'),
        import('./protocol.ts'),
        import('../driver/index.ts'),
        import('../driver/diagnostics.ts'),
        import('../extension-api.ts'),
        import('../lark/index.ts'),
        import('../load-config.ts'),
        import('../mcp/index.ts'),
        import('../runtime/index.ts'),
        import('../runtime-sdk.ts'),
        import('../settings.ts'),
        import('../vela.ts'),
      ]).then((mods) => Object.assign({}, ...mods, extraDaemonExports ?? {})),
    zod: () => import('zod'),
  })
}
