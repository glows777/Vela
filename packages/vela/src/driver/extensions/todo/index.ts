import type { VelaExtension } from '../../extension-api.ts'
import { createTodoTool } from './tool.ts'

/**
 * A task checklist the model keeps up to date. Stateless on our side: the whole list travels in
 * every tool call, so the latest call in the session is the current list.
 */
export function todo(): VelaExtension {
  const extension: VelaExtension = (vela) => {
    vela.registerTool(createTodoTool())
  }
  return Object.defineProperty(extension, 'name', { value: 'todo' })
}
