export type Role = 'owner' | 'collaborator' | 'guest'

export interface UserIdentity {
  id: string
  name: string
  role: Role
}

const TOOL_ACCESS: Record<Role, { allow: string[] | '*'; deny: string[] }> = {
  owner: {
    allow: '*',
    deny: [],
  },
  collaborator: {
    allow: '*',
    deny: ['bash'],
  },
  guest: {
    allow: ['read_file', 'list_directory', 'glob', 'grep', 'rag_search'],
    deny: [],
  },
}

export function canUseTool(role: Role, toolName: string): boolean {
  const access = TOOL_ACCESS[role]
  if (access.deny.includes(toolName)) return false
  if (access.allow === '*') return true
  return access.allow.includes(toolName)
}

export function filterToolsForRole(toolNames: string[], role: Role): string[] {
  return toolNames.filter((name) => canUseTool(role, name))
}
