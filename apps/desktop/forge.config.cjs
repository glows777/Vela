const { VitePlugin } = require('@electron-forge/plugin-vite')
const { dirname, join } = require('node:path')

module.exports = {
  packagerConfig: {
    asar: {
      unpack: '**/.vite/build/{daemon.mjs,photon_rs_bg.wasm,babel.cjs}',
    },
    extraResource: [
      'src/assets/fonts/Barlow-LICENSE.txt',
      'src/assets/fonts/JapaneseFonts-LICENSE.txt',
      join(
        dirname(require.resolve('@silvia-odwyer/photon-node')),
        'LICENSE.md',
      ),
    ],
    appBundleId: 'dev.vela.desktop',
    appCategoryType: 'public.app-category.developer-tools',
  },
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main/index.ts', config: 'vite.main.config.mjs' },
        { entry: 'src/main/daemon.ts', config: 'vite.daemon.config.mjs' },
        { entry: 'src/preload/index.ts', config: 'vite.preload.config.mjs' },
      ],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.mjs' }],
    }),
  ],
}
