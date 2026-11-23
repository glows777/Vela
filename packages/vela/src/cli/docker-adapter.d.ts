declare module '#docker-adapter' {
  export function openDockerEnvironment(
    options: {
      dataDir: string
      name: string
      image: string
      network?: 'on' | 'off' | 'restricted'
      allow?: readonly string[]
      credentials?: { variable: string; value: string; origins: string[] }[]
    },
    cwd: string,
  ): Promise<import('../driver/index.ts').ExecutionEnv>
}
