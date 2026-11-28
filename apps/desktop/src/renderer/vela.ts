import type { DesktopBridge } from '../shared/bridge.ts'

declare global {
  interface Window {
    vela: DesktopBridge
  }
}

/** The only way the page reaches main; preload defines it before the bundle runs. */
export const vela: DesktopBridge =
  typeof window === 'undefined'
    ? (undefined as unknown as DesktopBridge)
    : window.vela
