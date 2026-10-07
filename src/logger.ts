/**
 * 非事件类的诊断输出（插件加载、hook 出错、会话文件坏行……）。
 * core 不直接写终端：默认静默，CLI 传一个打到终端的实现。
 */
export interface VelaLogger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

const noop = () => {}

export const silentLogger: VelaLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
