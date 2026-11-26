/** @internal Retained OAuth client registration metadata across logouts. */
export interface OAuthRegistration {
  clientId: string
  hostId?: string
  subject?: string
}

/** @internal Storage seam for persisted OAuth client registrations (implemented in `runtime`, consumed in `providers`). */
export interface OAuthRegistrationStore {
  get(provider: string): OAuthRegistration | undefined
  set(provider: string, registration: OAuthRegistration): void
  delete(provider: string): boolean
}
