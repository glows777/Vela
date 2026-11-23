/** Storage sharing identity supplied by a host; it does not enable tools. */
export interface SessionScope {
  readonly id: string
  readonly kind: 'private' | 'shared'
  readonly dataDir: string
}
