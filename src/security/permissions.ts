/**
 * Session tool permissions. There are no roles (like pi): every session starts with all
 * tools allowed, and a channel's enabled-chat list is its trust boundary.
 */

/** allow: run; deny: refuse (the model never sees the tool); ask: confirm via the session's ui.confirm first, refuse when there is no UI */
export type PermissionDecision = 'allow' | 'deny' | 'ask'

/** Tool name (or `*` for all other tools) → decision */
export type PermissionRules = Record<string, PermissionDecision>

/**
 * A session's decision for a tool: its own rules, default `allow`. Within a rule set an
 * exact tool name beats `*`.
 */
export function decidePermission(
  toolName: string,
  rules?: PermissionRules,
): PermissionDecision {
  return rules?.[toolName] ?? rules?.['*'] ?? 'allow'
}
