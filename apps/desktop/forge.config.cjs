const { VitePlugin } = require('@electron-forge/plugin-vite')

module.exports = {
  packagerConfig: {
    asar: true,
    extraResource: [
      'src/assets/fonts/Barlow-LICENSE.txt',
      'src/assets/fonts/JapaneseFonts-LICENSE.txt',
      'src/renderer/components/arc/LICENSE.txt',
    ],
    appBundleId: 'dev.vela.desktop',
    appCategoryType: 'public.app-category.developer-tools',
  },
  plugins: [
    new VitePlugin({
      build: [{ entry: 'src/main/index.ts', config: 'vite.main.config.mjs' }],
      renderer: [{ name: 'main_window', config: 'vite.renderer.config.mjs' }],
    }),
  ],
}
