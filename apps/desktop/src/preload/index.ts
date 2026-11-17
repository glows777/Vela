import { contextBridge, ipcRenderer } from 'electron'
import {
  type DesktopBridge,
  EVENT,
  type Event,
  REQUEST,
  type Request,
} from '../shared/bridge.ts'

const invoke = (request: Request) => ipcRenderer.invoke(REQUEST, request)
const bridge: DesktopBridge = {
  channels: () => invoke({ method: 'channels' }),
  sessions: (channel, chatId) =>
    invoke({ method: 'sessions', channel, chatId }),
  connection: (channel) => invoke({ method: 'connection', channel }),
  submit: (channel, message) => invoke({ method: 'submit', channel, message }),
  stop: (channel, target, runId) =>
    invoke({ method: 'stop', channel, target, runId }),
  projects: () => invoke({ method: 'projects' }),
  openProject: (input) => invoke({ method: 'openProject', input }),
  messages: (input) => invoke({ method: 'messages', input }),
  onEvent: (listener) => {
    const receive = (_: unknown, event: Event) => listener(event)
    ipcRenderer.on(EVENT, receive)
    return () => ipcRenderer.removeListener(EVENT, receive)
  },
}
contextBridge.exposeInMainWorld('vela', bridge)
