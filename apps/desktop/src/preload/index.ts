import { contextBridge, ipcRenderer } from 'electron'
import {
  type DesktopBridge,
  EVENT,
  type Event,
  REQUEST,
  type Request,
} from '../shared/bridge.ts'

const ask = <T>(request: Request) =>
  ipcRenderer.invoke(REQUEST, request) as Promise<T>

const api: DesktopBridge = {
  channels: () => ask({ method: 'channels' }),
  settings: () => ask({ method: 'settings' }),
  saveModel: (input) => ask({ method: 'saveModel', input }),
  saveLark: (input) => ask({ method: 'saveLark', input }),
  savePreferences: (input) => ask({ method: 'savePreferences', input }),
  sessions: (channel, chatId) => ask({ method: 'sessions', channel, chatId }),
  createSession: (input) => ask({ method: 'createSession', input }),
  renameSession: (input) => ask({ method: 'renameSession', input }),
  deleteSession: (input) => ask({ method: 'deleteSession', input }),
  connection: (channel) => ask({ method: 'connection', channel }),
  submit: (channel, message) => ask({ method: 'submit', channel, message }),
  stop: (channel, target, runId) =>
    ask({ method: 'stop', channel, target, runId }),
  discoverLarkGroup: () => ask({ method: 'discoverLarkGroup' }),
  confirmLarkGroup: () => ask({ method: 'confirmLarkGroup' }),
  cancelLarkSetup: () => ask({ method: 'cancelLarkSetup' }),
  projects: () => ask({ method: 'projects' }),
  openProject: (input) => ask({ method: 'openProject', input }),
  removeProject: (input) => ask({ method: 'removeProject', input }),
  chooseFolder: () => ask({ method: 'chooseFolder' }),
  messages: (input) => ask({ method: 'messages', input }),
  openLarkChat: (chatId) => ask({ method: 'openLarkChat', chatId }),
  openMessageLink: (url) => ask({ method: 'openMessageLink', url }),
  copyMessageCode: (text) => ask({ method: 'copyMessageCode', text }),
  listRoutines: (channel, chatId) =>
    ask({ method: 'listRoutines', channel, chatId }),
  createRoutine: (channel, target, input) =>
    ask({ method: 'createRoutine', channel, target, input }),
  editRoutine: (channel, chatId, id, input) =>
    ask({ method: 'editRoutine', channel, chatId, id, input }),
  cancelRoutine: (channel, chatId, id) =>
    ask({ method: 'cancelRoutine', channel, chatId, id }),
  onEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: Event) => {
      listener(value)
    }
    ipcRenderer.on(EVENT, wrapped)
    return () => {
      ipcRenderer.off(EVENT, wrapped)
    }
  },
}

contextBridge.exposeInMainWorld('vela', api)
