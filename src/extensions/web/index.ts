import type { VelaExtension } from '../../index.ts'
import { configString } from '../config.ts'
import { serperSearchTool, tavilySearchTool, webFetchTool } from './tools.ts'

export interface WebOptions {
  /** Tavily API key; if both keys are given, Tavily wins */
  tavilyKey?: string
  /** Serper (Google search) API key */
  serperKey?: string
}

/**
 * Web tools: `web_fetch` fetches a page as Markdown; `web_search` is added when a search key is given.
 * Options not passed are read from the config section (`extensionConfig.web`).
 * Guest sessions can use web_search but not web_fetch (so outside senders cannot make Vela reach internal addresses).
 */
export function web(options: WebOptions = {}): VelaExtension {
  return function web(vela) {
    const tavilyKey =
      options.tavilyKey ?? configString(vela.config, 'tavilyKey')
    const serperKey =
      options.serperKey ?? configString(vela.config, 'serperKey')
    vela.registerTool(webFetchTool)
    if (tavilyKey) vela.registerTool(tavilySearchTool(tavilyKey))
    else if (serperKey) vela.registerTool(serperSearchTool(serperKey))
  }
}
