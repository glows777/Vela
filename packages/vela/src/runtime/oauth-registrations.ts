import type { VelaDatabase } from '../db/index.ts'
import type {
  OAuthRegistration,
  OAuthRegistrationStore,
} from '../shared/oauth-registration.ts'

type RegistrationRow = {
  provider: string
  client_id: string
  host_id: string | null
  subject: string | null
  updated_at: string
}

/**
 * Persists non-token OAuth client registrations in `vela.db` (`oauth_registrations`)
 * so `/logout` can clear active tokens while preserving device registration and account identity.
 */
export class SqliteOAuthRegistrationStore implements OAuthRegistrationStore {
  constructor(private readonly db: VelaDatabase) {}

  get(provider: string): OAuthRegistration | undefined {
    const row = this.db.get<RegistrationRow>(
      'SELECT provider, client_id, host_id, subject, updated_at FROM oauth_registrations WHERE provider = ?',
      provider,
    )
    if (!row) return undefined
    return {
      clientId: row.client_id,
      ...(row.host_id ? { hostId: row.host_id } : {}),
      ...(row.subject ? { subject: row.subject } : {}),
    }
  }

  set(provider: string, registration: OAuthRegistration): void {
    this.db.run(
      `INSERT INTO oauth_registrations (provider, client_id, host_id, subject, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET
         client_id = excluded.client_id,
         host_id = excluded.host_id,
         subject = excluded.subject,
         updated_at = excluded.updated_at`,
      provider,
      registration.clientId,
      registration.hostId ?? null,
      registration.subject ?? null,
      new Date().toISOString(),
    )
  }

  delete(provider: string): boolean {
    const result = this.db.run(
      'DELETE FROM oauth_registrations WHERE provider = ?',
      provider,
    )
    return result.changes > 0
  }
}
