// PKCE helpers, adapted from pi-mono (packages/ai/src/auth/oauth/pkce.ts, MIT).
import { Buffer } from 'node:buffer'

const base64url = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString('base64url')

/** A random URL-safe value (state, nonce) */
export function randomValue(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)))
}

/** PKCE code verifier and its S256 challenge */
export async function generatePKCE(): Promise<{
  verifier: string
  challenge: string
}> {
  const verifier = randomValue()
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  )
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
}
