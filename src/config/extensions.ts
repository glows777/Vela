import { pathToFileURL } from 'node:url'
import type { VelaExtension } from '../extensions/types'

/**
 * 加载一个扩展文件：默认导出 `(vela) => {}`。返回的函数名是扩展名（决定工具前缀和配置段）。
 * Bun 直接加载 `.ts`，扩展不需要构建（pi 为此用 jiti）。
 */
export async function importExtension(
  path: string,
  name: string,
): Promise<VelaExtension> {
  const module = (await import(pathToFileURL(path).href)) as {
    default?: unknown
  }
  const factory = module.default
  if (typeof factory !== 'function')
    throw new Error(`扩展 ${path} 没有默认导出 (vela) => {}`)
  // 用计算属性名给函数命名：runner 用 extension.name 作扩展名
  return {
    [name]: (vela: Parameters<VelaExtension>[0]) =>
      (factory as VelaExtension)(vela),
  }[name] as VelaExtension
}
