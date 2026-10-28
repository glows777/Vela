/** Storage sharing identity supplied by a host; it grants no tool permissions. */
export interface SessionScope {
  readonly id: string
  readonly kind: 'private' | 'shared'
  readonly dataDir: string
}
