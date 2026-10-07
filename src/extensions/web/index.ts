import type { VelaExtension } from '../../index'
import { serperSearchTool, tavilySearchTool, webFetchTool } from './tools'

export interface WebOptions {
  /** Tavily API key；同时给了两个 key 时优先用 Tavily */
  tavilyKey?: string
  /** Serper（Google 搜索）API key */
  serperKey?: string
}

/**
 * 网页工具：`web_fetch` 抓取网页转成 Markdown；给了搜索 key 时再加 `web_search`。
 * guest 会话能用 web_search，不能用 web_fetch（避免外部发送者让 Vela 访问内网地址）。
 */
export function web(options: WebOptions = {}): VelaExtension {
  return function web(vela) {
    vela.registerTool(webFetchTool)
    if (options.tavilyKey)
      vela.registerTool(tavilySearchTool(options.tavilyKey))
    else if (options.serperKey)
      vela.registerTool(serperSearchTool(options.serperKey))
  }
}
