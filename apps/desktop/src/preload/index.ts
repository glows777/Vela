import { contextBridge, ipcRenderer } from 'electron'
import {
  type DesktopBridge,
  EVENT,
  type Event,
  REQUEST,
  type Request,
} from '../shared/bridge.ts'

/**
 * Electron wraps a handler's failure as `Error invoking remote method 'vela:request':
 * Error: <message>`. The page shows the host's own words, so the wrapper goes here.
 */
const unwrap = (cause: unknown) =>
  (cause instanceof Error ? cause.message : String(cause)).replace(
    /^Error invoking remote method '[^']*': (?:\w*Error: )?/,
    '',
  )
const invoke = async (request: Request) => {
  try {
    return await ipcRenderer.invoke(REQUEST, request)
  } catch (cause) {
    throw new Error(unwrap(cause))
  }
}
const bridge: DesktopBridge = {
  channels: () => invoke({ method: 'channels' }),
  settings: () => invoke({ method: 'settings' }),
  saveModel: (input) => invoke({ method: 'saveModel', input }),
  sessions: (channel, chatId) =>
    invoke({ method: 'sessions', channel, chatId }),
  connection: (channel) => invoke({ method: 'connection', channel }),
  submit: (channel, message) => invoke({ method: 'submit', channel, message }),
  stop: (channel, target, runId) =>
    invoke({ method: 'stop', channel, target, runId }),
  projects: () => invoke({ method: 'projects' }),
  openProject: (input) => invoke({ method: 'openProject', input }),
  chooseFolder: () => invoke({ method: 'chooseFolder' }),
  messages: (input) => invoke({ method: 'messages', input }),
  listRoutines: (channel, chatId) =>
    invoke({ method: 'listRoutines', channel, chatId }),
  createRoutine: (channel, target, input) =>
    invoke({ method: 'createRoutine', channel, target, input }),
  editRoutine: (channel, chatId, id, input) =>
    invoke({ method: 'editRoutine', channel, chatId, id, input }),
  cancelRoutine: (channel, chatId, id) =>
    invoke({ method: 'cancelRoutine', channel, chatId, id }),
  onEvent: (listener) => {
    const receive = (_: unknown, event: Event) => listener(event)
    ipcRenderer.on(EVENT, receive)
    return () => ipcRenderer.removeListener(EVENT, receive)
  },
}
contextBridge.exposeInMainWorld('vela', bridge)
