/**
 * Session roles and tool permissions. Roles belong to sessions: the CLI owner defaults to
 * owner, channel senders default to guest.
 *
 * - owner: all tools
 * - collaborator: all except bash
 * - guest: only tools that don't touch the machine (knowledge base search, web search,
 *   deferred tool lookup); no file access, commands or memory, and the owner's memory is
 *   not injected into the system prompt
 *
 * rag_search / web_search come from the built-in rag and web extensions. Extension tool names
 * carry an `<extension name>_` prefix, so only extensions named rag / web can register these
 * names (duplicates throw); no other extension can get guest access.
 */
export type Role = 'owner' | 'collaborator' | 'guest'

export const ROLES: readonly Role[] = ['owner', 'collaborator', 'guest']

/** allow: run; deny: refuse (the model never sees the tool); ask: confirm via the session's ui.confirm first, refuse when there is no UI */
export type PermissionDecision = 'allow' | 'deny' | 'ask'

/** Tool name (or `*` for all other tools) → decision */
export type PermissionRules = Record<string, PermissionDecision>

const ROLE_RULES: Record<Role, PermissionRules> = {
  owner: { '*': 'allow' },
  collaborator: { '*': 'allow', bash: 'deny' },
  guest: {
    '*': 'deny',
    rag_search: 'allow',
    web_search: 'allow',
    tool_search: 'allow',
  },
}

const STRICTNESS: Record<PermissionDecision, number> = {
  allow: 0,
  ask: 1,
  deny: 2,
}

/**
 * A session's decision for a tool. The role is the upper bound; `overrides` are the
 * session's own rules (`vela.session(id, { permissions })`) and can only tighten it:
 * `ask` / `deny` apply to tools the role allows, while `allow` on a tool the role forbids
 * stays `deny`. Within each rule set an exact tool name beats `*`.
 */
export function decidePermission(
  role: Role,
  toolName: string,
  overrides?: PermissionRules,
): PermissionDecision {
  const rules = ROLE_RULES[role]
  const byRole = rules[toolName] ?? rules['*'] ?? 'deny'
  const bySession = overrides?.[toolName] ?? overrides?.['*'] ?? byRole
  return STRICTNESS[bySession] > STRICTNESS[byRole] ? bySession : byRole
}

export function canUseTool(role: Role, toolName: string): boolean {
  return decidePermission(role, toolName) !== 'deny'
}

export function filterToolsForRole(toolNames: string[], role: Role): string[] {
  return toolNames.filter((name) => canUseTool(role, name))
}
