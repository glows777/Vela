/** Explicit host inputs; extensions never read the process environment implicitly. */
export interface ExtensionConfigContext {
  cwd: string
  agentDir: string
  projectDir: string
  trusted: boolean
  env: Record<string, string | undefined>
}

/** An extension owns its section and any additional trust-requiring files. */
export interface ExtensionConfigDefinition {
  readonly name: string
  readonly projectResources?: readonly string[]
  resolve(
    section: Readonly<Record<string, unknown>>,
    context: ExtensionConfigContext,
  ): Record<string, unknown>
}
