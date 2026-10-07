import type { VelaExtension } from '../../index'
import { configString } from '../config'
import { serperSearchTool, tavilySearchTool, webFetchTool } from './tools'

export interface WebOptions {
  /** Tavily API key；同时给了两个 key 时优先用 Tavily */
  tavilyKey?: string
  /** Serper（Google 搜索）API key */
  serperKey?: string
}

/**
 * 网页工具：`web_fetch` 抓取网页转成 Markdown；给了搜索 key 时再加 `web_search`。
 * 没传的选项从配置段（`extensionConfig.web`）取。
 * guest 会话能用 web_search，不能用 web_fetch（避免外部发送者让 Vela 访问内网地址）。
 */
export function web(options: WebOptions = {}): VelaExtension {
  return function web(vela) {
    const tavilyKey = options.tavilyKey ?? configString(vela.config, 'tavilyKey')
    const serperKey = options.serperKey ?? configString(vela.config, 'serperKey')
    vela.registerTool(webFetchTool)
    if (tavilyKey) vela.registerTool(tavilySearchTool(tavilyKey))
    else if (serperKey) vela.registerTool(serperSearchTool(serperKey))
  }
}
