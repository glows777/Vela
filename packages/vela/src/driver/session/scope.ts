/** @internal Storage sharing identity supplied by a host; transitional until S4b deletes `legacy-channels`. */
export interface SessionScope {
  readonly id: string
  readonly kind: 'private' | 'shared'
  readonly dataDir: string
}
