declare module '#docker-adapter' {
  export function openDockerEnvironment(
    options: {
      dataDir: string
      name: string
      image: string
      network?: 'on' | 'off'
    },
    cwd: string,
  ): Promise<import('@glows777/vela-core').ExecutionEnv>
}
