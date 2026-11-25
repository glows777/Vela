# Docker execution environment

This runtime adapter runs Linux containers from a non-root Linux or macOS host and implements Vela's `ExecutionEnv` contract via `EnvironmentRegistry` (`packages/vela/src/runtime/environments.ts`). The workspace build emits `dist/docker/guest.cjs`, bundled inside the installed `@glows777/vela` package. The owner-side factory resolves named entries from the owner's `environments` settings.

First preparation creates or reopens one labeled container per canonical data directory and environment name. It mounts the allocated workspace and, in restricted mode, one read-only proxy directory. It runs as the host's non-root uid:gid, and checks for both `rg` and `fd` before returning an adapter. The owner supplies a local image. The reference Dockerfile (`packages/vela/src/runtime/docker/Dockerfile`) includes the expected tools. Network defaults to `on`. The `off` setting uses Docker's `none` network. Commands run through `DOCKER_HOST` or the default local Linux Docker socket at `unix:///var/run/docker.sock`.

Cleanup closes open readers and stops this adapter's command groups. The named container and result files survive adapter cleanup. A change to the image, network, restricted allowlist, or user requires explicit owner recreation of the labeled container. Recreating it preserves the bind-mounted workspace and discards container-local files.

On macOS the engine must already serve the configured socket and share the owner-allocated workspace. Files written there must be owned by the host user and writable from both sides. The group reported on the Mac can differ from the group seen in the Linux container.

### Host credentials with networking on

Add credentials only to the owner's environment settings, not a project's settings:

```json
{
  "environments": {
    "release-test": {
      "image": "vela-base:local",
      "network": "on",
      "credentials": {
        "GH_TOKEN": {
          "value": "$GH_TOKEN",
          "origins": ["https://github.com", "https://api.github.com"]
        }
      }
    }
  }
}
```

Set the referenced variable on the Vela host and use a fine-grained token limited to the repositories and operations you need. The host needs OpenSSL. Vela gives Docker commands a placeholder, not the original credential. Its host-side HTTPS proxy substitutes the value only in a supported Authorization header for an exact configured origin; Git HTTPS gets a helper for the GitHub origin. A missing host value or invalid origin fails before the environment opens. This setting cannot be combined with `network: off`.

`network: on` does not restrict egress. A container-local HTTPS router sends configured origins to the host credential proxy and opens ordinary HTTPS connections from the container itself. The guest keeps its existing trust roots and adds Vela's public CA for the credential proxy. Tools that ignore the proxy may connect directly, but they only receive the placeholder so authentication fails if they send it. The host credential proxy is not a general HTTPS proxy and only accepts configured origins. No project or chat input can enable the credential settings.

### Restricted HTTPS egress on Linux

For a named environment in the owner settings, set `"network": "restricted"` and supply a non-empty `"allow": ["github.com", "api.github.com"]`. Use exact DNS names, not IP addresses, wildcards, paths, or ports. Do not supply `allow` with `on` or `off`. Credentials are optional; every configured credential origin must be on the allowlist.

This mode uses Docker's `none` network and a dedicated read-only Unix socket directory. Only approved HTTPS requests through the proxy can leave the container. Clients must honor the standard HTTPS proxy and CA settings; direct connections, plain HTTP, SSH, and other ports are not supported. An unavailable proxy does not reopen networking. The mode requires a non-root Linux host with the supported local Docker socket, a working Unix socket bind mount, and OpenSSL. macOS does not support this mode. Reopening an unchanged environment keeps its container and workspace; changing the allowlist requires explicit owner recreation.

To run the optional real-engine check after a frozen install, set `VELA_TEST_DOCKER_IMAGE` to a suitable local image (including curl for the restricted HTTPS test) and run `bun test test/e2e/docker-image.test.ts`. The test uses disposable owner directories, disables networking and removes its own containers. The default offline suite exercises the operations and lifecycle separately. To exercise rollback for an incompatible image, also set `VELA_TEST_DOCKER_VOLUME_IMAGE` to a disposable local derivative declaring `VOLUME ["/vela-test-volume"]`.
