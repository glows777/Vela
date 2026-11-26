/** @internal Storage sharing identity supplied by a host; transitional until S4b deletes `legacy-channels`. */
export interface SessionScope {
  readonly id: string
  readonly kind: 'private' | 'shared'
  readonly dataDir: string
}

const registryScopes = new WeakMap<
  object,
  () => Readonly<SessionScope> | undefined
>()
const toolContextScopes = new WeakMap<object, Readonly<SessionScope>>()

/** @internal */
export function setRegistryScope(
  registry: object,
  getScope: () => Readonly<SessionScope> | undefined,
): void {
  registryScopes.set(registry, getScope)
}

/** @internal */
export function getRegistryScope(
  registry: object,
): Readonly<SessionScope> | undefined {
  return registryScopes.get(registry)?.()
}

/** @internal */
export function setToolContextScope(
  context: object,
  scope: Readonly<SessionScope>,
): void {
  toolContextScopes.set(context, scope)
}

/** @internal */
export function getToolContextScope(
  context: object | undefined,
): Readonly<SessionScope> | undefined {
  return context ? toolContextScopes.get(context) : undefined
}
