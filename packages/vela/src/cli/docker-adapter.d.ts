declare module '#docker-adapter' {
  export function openDockerEnvironment(
    options: {
      dataDir: string
      name: string
      image: string
      network?: 'on' | 'off'
      credentials?: { variable: string; value: string; origins: string[] }[]
    },
    cwd: string,
  ): Promise<import('@glows777/vela-core').ExecutionEnv>
}
