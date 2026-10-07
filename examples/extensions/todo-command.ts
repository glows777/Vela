/**
 * registerCommand + ctx.ui.notify：`/todo 买牛奶` 记一条待办，`/todo` 列出。
 * 命令只在 owner 会话里执行（通道发送者发来的 `/todo` 是普通文本）。
 * 没有界面时 notify 变成 `notify` 事件。
 */
import type { VelaExtension } from 'vela'

const todo: VelaExtension = (vela) => {
  // 每个会话一份待办
  const todos = new Map<string, string[]>()

  vela.registerCommand('todo', {
    description: '记一条待办；不带参数时列出',
    handler: (args, ctx) => {
      const list = todos.get(ctx.session.id) ?? []
      todos.set(ctx.session.id, list)
      if (args) {
        list.push(args)
        ctx.ui.notify(`已记下：${args}`)
      } else {
        ctx.ui.notify(list.length ? list.join('\n') : '没有待办')
      }
    },
  })
}

export default todo
