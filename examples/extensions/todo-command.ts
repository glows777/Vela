/**
 * registerCommand + ctx.notify: `/todo buy milk` adds a todo, `/todo` lists them.
 * Notifications are emitted as `notify` events on the session event stream.
 */
import type { VelaExtension } from '@glows777/vela/extension-api'

const todo: VelaExtension = (vela) => {
  // One todo list per session
  const todos = new Map<string, string[]>()

  vela.registerCommand('todo', {
    description: 'Add a todo; with no arguments, list todos',
    handler: (args, ctx) => {
      const list = todos.get(ctx.session.id) ?? []
      todos.set(ctx.session.id, list)
      if (args) {
        list.push(args)
        ctx.notify(`Added: ${args}`)
      } else {
        ctx.notify(list.length ? list.join('\n') : 'No todos')
      }
    },
  })
}

export default todo
