import type {
  ExtensionConfigDefinition,
  VelaExtension,
} from '../../extension-api.ts'
import { configString } from '../../extension-api.ts'
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
    else vela.registerTool({ ...tavilySearchTool(''), hostedOnly: true })
    vela.on('before_provider_request', (event, ctx) => {
      if (
        !event.params.tools?.length ||
        ctx.session.toolDecision('web_search') !== 'ask'
      )
        return
      ctx.ui.notify(
        tavilyKey || serperKey
          ? 'Web search uses the configured independent provider and requires approval for each call.'
          : 'Web search is unavailable: per-call approval requires a configured independent search provider.',
      )
    })
  }
}

export const webConfig: ExtensionConfigDefinition = {
  name: 'web',
  resolve(section, context) {
    return {
      tavilyKey: context.env.TAVILY_API_KEY,
      serperKey: context.env.SERPER_API_KEY,
      ...section,
    }
  },
}
