import type { VelaEvent } from '../agent/events'

/**
 * 把核心事件按原来的终端格式打印出来。
 * 第 0 步只做“输出效果不变”的搬运；更友好的 TUI 渲染在后续步骤里替换它。
 */
export function printEvent(event: VelaEvent): void {
  switch (event.type) {
    case 'turn_start':
      console.log(`\n--- Agent Loop Turn ${event.turn} ---\n`)
      break
    case 'text_delta':
      process.stdout.write(event.text)
      break
    case 'tool_call':
      console.log(
        `\n  [tool called: ${event.toolName}->(${JSON.stringify(event.input)})]`,
      )
      break
    case 'loop_detected':
      console.log(event.message)
      break
    case 'tool_result':
      console.log(
        `  [tool called result: ${event.toolName}->${JSON.stringify(event.output)}]`,
      )
      break
    case 'retry':
      console.log(
        `  [Retry] Attempt ${event.attempt}/${event.maxRetries} failed, retrying in ${event.delayMs}ms...`,
      )
      break
    case 'usage': {
      // cache 命中时才打印一行简洁状态，让 cache hit 立刻可见
      const { usage, record } = event
      if (
        !record ||
        (usage.cacheReadTokens <= 0 && usage.cacheWriteTokens <= 0)
      )
        break
      const tag =
        usage.cacheReadTokens > 0
          ? `\x1b[38;5;36m✓ cache hit\x1b[0m`
          : `\x1b[38;5;220m✎ cache write\x1b[0m`
      const detail =
        usage.cacheReadTokens > 0
          ? `read ${usage.cacheReadTokens}`
          : `write ${usage.cacheWriteTokens}`
      console.log(
        `\n [${tag}] ${detail} tokens · current step $${record.cost.toFixed(5)}`,
      )
      break
    }
    case 'budget_warning':
      console.log(
        `  [Token] ${event.used}/${event.limit} (${Math.round((event.used / event.limit) * 100)}%)`,
      )
      break
    case 'turn_end':
      if (event.needsToolCall)
        console.log('agent needs to call tool, continue to next turn')
      break
    case 'agent_end':
      if (event.reason === 'done')
        console.log('\n--- Agent has completed its response. Ending loop. ---')
      else if (event.reason === 'loop')
        console.log(
          '\nAgent is stuck in a loop and has reached the critical threshold. Ending loop.',
        )
      else if (event.reason === 'budget')
        console.log('\n[Token has exceeded the budget limit. Ending loop.]')
      else if (event.reason === 'max_turns')
        console.log(
          '\nReached maximum turn limit. Ending loop to prevent infinite execution.',
        )
      break
    case 'context':
      if (event.action === 'micro')
        console.log(
          `[Context] action=micro before=${event.before} after=${event.after} saved=${event.saved} calls=${event.calls}`,
        )
      else if (event.action === 'summary-required')
        console.log(
          `[Context] action=summary-required before=${event.before} microSavings=${event.saved}; 下次模型请求时生成摘要`,
        )
      else
        console.log(
          `[Context] action=summary before=${event.before} after=${event.after} messages=${event.messages}`,
        )
      break
    case 'session_save_failed':
      console.error(
        '[Session] 保存失败:',
        event.error instanceof Error ? event.error.message : event.error,
      )
      break
    case 'tool_error':
      break
  }
}
