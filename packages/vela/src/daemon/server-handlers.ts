import type { Socket } from 'node:net'
import type { LocalVelaRuntime } from '../runtime-sdk-types.ts'
import { createAuthLoginHandler, type PendingLoginClient } from './auth-rpc.ts'
import {
  type DaemonHello,
  type DaemonStatus,
  parseChannelChatsParams,
  parseChannelSetEnabledParams,
  parseChannelSubmitParams,
} from './protocol.ts'
import { resolveSettingsOwnerHooks } from './settings-discovery.ts'
import type {
  DaemonWebhooksHost,
  startDaemonConfigWatcher,
} from './webhooks-host.ts'

export interface ConnectedClient {
  socket: Socket
  disconnected: boolean
  subEvents: boolean
  subDeltas: boolean
  subChannels: boolean
  configuredSessions: Set<string>
  activeLogins: Map<number, PendingLoginClient>
  activeLogouts: Map<number, AbortController>
  activeDiscoveries: Map<number, AbortController>
  preCancelledLogins: Set<number>
  preCancelledLogouts: Set<number>
  preCancelledDiscoveries: Set<number>
  isDisconnected: () => boolean
}

export type DaemonRpcHandler = (
  // biome-ignore lint/suspicious/noExplicitAny: RPC params decoded dynamically from NDJSON
  p: any,
  client: ConnectedClient,
) => Promise<unknown> | unknown

export function createDaemonHandlers(deps: {
  runtime: LocalVelaRuntime
  hello: DaemonHello
  startedAtMs: number
  webhooksHost?: DaemonWebhooksHost
  getConfigWatcher: () =>
    | ReturnType<typeof startDaemonConfigWatcher>
    | undefined
  requestClose: (reason: string) => void
  nextPromptId: () => number
  sessionOverrideOwners: Map<string, ConnectedClient>
  serializeSessionConfigure: <T>(
    sessionId: string,
    fn: () => Promise<T>,
  ) => Promise<T>
}): Record<string, DaemonRpcHandler> {
  const {
    runtime,
    hello,
    startedAtMs,
    webhooksHost,
    getConfigWatcher,
    requestClose,
    nextPromptId,
    sessionOverrideOwners,
    serializeSessionConfigure,
  } = deps

  return {
    'daemon.hello': () => hello,
    'daemon.status': async (): Promise<DaemonStatus> => {
      await getConfigWatcher()?.checkNow()
      return {
        running: true,
        agentDir: hello.agentDir,
        socketPath: hello.socketPath,
        pid: hello.pid,
        protocolVersion: hello.protocolVersion,
        appVersion: hello.appVersion,
        startedAt: hello.startedAt,
        uptimeMs: Math.max(0, Date.now() - startedAtMs),
        channels: await runtime.channels.list(),
        ...(webhooksHost ? { webhooks: webhooksHost.status() } : {}),
      }
    },
    'daemon.stop': () => {
      setImmediate(() => requestClose('rpc'))
      return { stopping: true }
    },
    'runtime.ready': () => runtime.ready(),
    'runtime.extensionErrors': () => runtime.extensionErrors(),
    'runtime.reloadConfig': () => runtime.reloadConfig(),
    'projects.list': (p) => runtime.projects.list(p),
    'projects.get': (p) => runtime.projects.get(p.id),
    'projects.getByCwd': (p) => runtime.projects.getByCwd(p.cwd),
    'projects.create': (p) => runtime.projects.create(p),
    'projects.update': (p) => runtime.projects.update(p.id, p.patch),
    'projects.remove': (p) => runtime.projects.remove(p.id, p.options),
    'trust.check': (p) => runtime.trust.check(p.location),
    'trust.approve': (p) => runtime.trust.approve(p.location, p.trusted),
    'oauthRegistrations.get': (p) => runtime.oauthRegistrations.get(p.provider),
    'oauthRegistrations.set': (p) =>
      runtime.oauthRegistrations.set(p.provider, p.registration),
    'oauthRegistrations.delete': (p) =>
      runtime.oauthRegistrations.delete(p.provider),
    'sessions.list': (p) => runtime.sessions.list(p),
    'sessions.listSummaries': (p) => runtime.sessions.listSummaries(p),
    'sessions.get': (p) => runtime.sessions.get(p.id),
    'sessions.create': (p) => runtime.sessions.create(p),
    'sessions.rename': (p) => runtime.sessions.rename(p.id, p.name),
    'sessions.delete': (p) =>
      serializeSessionConfigure(p.id, async () => {
        const prevOwner = sessionOverrideOwners.get(p.id)
        if (prevOwner) {
          prevOwner.configuredSessions.delete(p.id)
          sessionOverrideOwners.delete(p.id)
        }
        return runtime.sessions.delete(p.id)
      }),
    'sessions.reset': (p) => runtime.sessions.reset(p.id),
    'sessions.status': (p) => runtime.sessions.status(p.id),
    'sessions.messages': (p) => runtime.sessions.messages(p),
    'sessions.configure': (p, client) =>
      serializeSessionConfigure(p.sessionId, async () => {
        const empty = !p.override || Object.keys(p.override).length === 0
        if (empty) {
          if (sessionOverrideOwners.get(p.sessionId) !== client) {
            return
          }
          sessionOverrideOwners.delete(p.sessionId)
          client.configuredSessions.delete(p.sessionId)
          await runtime.sessions.configure(p.sessionId, p.override)
          return
        }
        if (client.isDisconnected()) return
        const prevOwner = sessionOverrideOwners.get(p.sessionId)
        if (prevOwner && prevOwner !== client) {
          prevOwner.configuredSessions.delete(p.sessionId)
        }
        sessionOverrideOwners.set(p.sessionId, client)
        client.configuredSessions.add(p.sessionId)
        await runtime.sessions.configure(p.sessionId, p.override)
      }),
    'sessions.setModel': (p) =>
      runtime.sessions.setModel(p.sessionId, p.modelRef),
    'sessions.setThinkingLevel': (p) =>
      runtime.sessions.setThinkingLevel(p.sessionId, p.level),
    'sessions.compact': (p) =>
      runtime.sessions.compact(p.sessionId, p.instructions),
    'sessions.tree': (p) => runtime.sessions.tree(p.sessionId),
    'sessions.navigateTree': (p) =>
      runtime.sessions.navigateTree(p.sessionId, p.targetId, p.options),
    'sessions.setLabel': (p) =>
      runtime.sessions.setLabel(p.sessionId, p.entryId, p.label),
    'sessions.fork': (p) =>
      runtime.sessions.fork(p.sessionId, p.entryId, p.options),
    'sessions.clone': (p) => runtime.sessions.clone(p.sessionId, p.options),
    'sessions.inspect': (p) => runtime.sessions.inspect(p.sessionId, p.options),
    'sessions.execBash': (p) =>
      runtime.sessions.execBash(p.sessionId, p.command, p.options),
    'sessions.abortBash': (p) => runtime.sessions.abortBash(p.sessionId),
    'sessions.runCommand': (p) =>
      runtime.sessions.runCommand(p.sessionId, p.input),
    'sessions.clearQueue': (p) => runtime.sessions.clearQueue(p.sessionId),
    'sessions.export': (p) =>
      runtime.sessions.export(p.sessionId, p.format, p.outputPath, p.baseCwd),
    'runtime.prompt': (p) => runtime.prompt(p.sessionId, p.input),
    'runtime.steer': (p) => runtime.steer(p.sessionId, p.text, p.images),
    'runtime.stop': (p) => runtime.stop(p.sessionId, p.reason, p.options),
    'runtime.waitForIdle': (p) => runtime.waitForIdle(p?.sessionId),
    'jobs.list': (p) => runtime.jobs.list(p?.sessionId),
    'jobs.stop': (p) => runtime.jobs.stop(p.sessionId, p.jobId),
    'jobs.promoteForeground': (p) =>
      runtime.jobs.promoteForeground(p.sessionId, p.toolCallId),
    'approvals.list': (p) => runtime.approvals.list(p?.sessionId),
    'approvals.resolve': (p) => runtime.approvals.resolve(p),
    'timers.list': (p) => runtime.timers.list(p),
    'timers.createRoutine': (p) => runtime.timers.createRoutine(p),
    'timers.createFollowup': (p) => runtime.timers.createFollowup(p),
    'timers.update': (p) => runtime.timers.update(p.id, p.patch),
    'timers.delete': (p) => runtime.timers.delete(p.id, p.filter),
    'subscriptions.list': (p) => runtime.subscriptions.list(p),
    'subscriptions.create': (p) => runtime.subscriptions.create(p),
    'subscriptions.remove': (p) => runtime.subscriptions.remove(p.id),
    'bindings.list': (p) => runtime.bindings.list(p),
    'bindings.get': (p) => runtime.bindings.get(p.id),
    'bindings.upsert': (p) => runtime.bindings.upsert(p),
    'bindings.setEnabled': (p) => runtime.bindings.setEnabled(p.id, p.enabled),
    'bindings.remove': (p) => runtime.bindings.remove(p.id),
    'channels.list': () => runtime.channels.list(),
    'channels.setEnabled': (p) => {
      const { name, enabled } = parseChannelSetEnabledParams(p)
      return runtime.channels.setEnabled(name, enabled)
    },
    'channels.chats': (p) => {
      const { channel } = parseChannelChatsParams(p)
      return runtime.channels.chats(channel)
    },
    'channels.submit': (p) => {
      const { channel, input } = parseChannelSubmitParams(p)
      return runtime.channels.submit(channel, input)
    },
    'channels.subscribe': (_p, c) => {
      c.subChannels = true
      return true
    },
    'channels.unsubscribe': (_p, c) => {
      c.subChannels = false
      return true
    },
    'settings.get': () => runtime.settings.get(),
    'settings.saveModel': (p) => runtime.settings.saveModel(p.input),
    'settings.saveLark': (p) => runtime.settings.saveLark(p.input),
    'settings.discoverLarkGroup': async (
      p: { setupId?: number } | undefined,
      client: ConnectedClient,
    ) => {
      if (client.isDisconnected()) return undefined
      const setupId = p?.setupId
      const controller = new AbortController()
      if (typeof setupId === 'number') {
        if (client.preCancelledDiscoveries.delete(setupId)) {
          controller.abort(new DOMException('Cancelled', 'AbortError'))
        }
        client.activeDiscoveries.set(setupId, controller)
      }
      if (controller.signal.aborted || client.isDisconnected()) {
        if (typeof setupId === 'number') {
          client.activeDiscoveries.delete(setupId)
        }
        return undefined
      }
      try {
        const hooks = await resolveSettingsOwnerHooks(runtime)
        if (client.isDisconnected() || controller.signal.aborted) {
          return undefined
        }
        if (hooks) {
          return await hooks.discoverLarkGroup(client, controller.signal)
        }
        return await runtime.settings.discoverLarkGroup({
          signal: controller.signal,
        })
      } finally {
        if (typeof setupId === 'number') {
          client.activeDiscoveries.delete(setupId)
        }
      }
    },
    'settings.confirmLarkGroup': async (p, client: ConnectedClient) => {
      const hooks = await resolveSettingsOwnerHooks(runtime)
      return hooks
        ? hooks.confirmLarkGroup(client, p.chatId)
        : runtime.settings.confirmLarkGroup(p.chatId)
    },
    'settings.cancelLarkSetup': async (_p, client: ConnectedClient) => {
      for (const ctrl of client.activeDiscoveries.values()) {
        ctrl.abort(new DOMException('Cancelled', 'AbortError'))
      }
      const hooks = await resolveSettingsOwnerHooks(runtime)
      if (hooks) {
        await hooks.cancelLarkSetup(client)
      }
    },
    'blobs.get': (p) => runtime.blobs.get(p.id),
    'blobs.list': (p) => runtime.blobs.list(p.sessionId, p.direction),
    'blobs.read': (p) => runtime.blobs.read(p.id),
    'blobs.storeInbound': (p) => runtime.blobs.storeInbound(p),
    'events.list': (p) => runtime.events.list(p),
    'events.bufferedDeltas': (p) => runtime.events.bufferedDeltas(p.sessionId),
    'events.subscribe': (_p, c) => {
      c.subEvents = true
      return true
    },
    'events.unsubscribe': (_p, c) => {
      c.subEvents = false
      return true
    },
    'events.subscribeDeltas': (_p, c) => {
      c.subDeltas = true
      return true
    },
    'events.unsubscribeDeltas': (_p, c) => {
      c.subDeltas = false
      return true
    },
    'runtime.models': (p) => runtime.models(p),
    'runtime.loginProviders': () => runtime.loginProviders(),
    'runtime.logout': async (
      p: {
        provider: string
        logoutId?: number
        options?: { forget?: boolean }
      },
      client: ConnectedClient,
    ) => {
      if (client.isDisconnected()) {
        throw new DOMException('Client disconnected', 'AbortError')
      }
      const controller = new AbortController()
      if (typeof p.logoutId === 'number') {
        if (client.preCancelledLogouts.delete(p.logoutId)) {
          controller.abort(new DOMException('Logout cancelled', 'AbortError'))
        }
        client.activeLogouts.set(p.logoutId, controller)
      }
      try {
        return await runtime.logout(p.provider, {
          ...p.options,
          signal: controller.signal,
        })
      } finally {
        if (typeof p.logoutId === 'number') {
          client.activeLogouts.delete(p.logoutId)
        }
      }
    },
    'runtime.recover': () => runtime.recover(),
    'auth.login': createAuthLoginHandler(runtime, nextPromptId),
  }
}
