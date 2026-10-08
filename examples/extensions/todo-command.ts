/**
 * registerCommand + ctx.ui.notify: `/todo buy milk` adds a todo, `/todo` lists them.
 * Commands run only in owner sessions (a `/todo` from a channel sender is plain text).
 * With no UI, notify becomes a `notify` event.
 */
import type { VelaExtension } from '@glows777/vela'

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
        ctx.ui.notify(`Added: ${args}`)
      } else {
        ctx.ui.notify(list.length ? list.join('\n') : 'No todos')
      }
    },
  })
}

export default todo
