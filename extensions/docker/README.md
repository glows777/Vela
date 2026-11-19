# Docker execution environment

This private adapter runs Linux containers from a non-root Linux or macOS host and implements Vela's existing `ExecutionEnv` contract. The workspace build emits `dist/docker/adapter.mjs` and its sibling `guest.cjs`. The owner-side factory is `openDockerEnvironment({ dataDir, name, image, network }, cwd)`. Its cwd defaults to `/workspace`. Session location selection and extension registration are pending E3b.

First preparation creates or reopens one labeled container per canonical data directory and environment name. It mounts only the allocated workspace, runs as the host's non-root uid:gid, and checks for both `rg` and `fd` before returning an adapter. The owner supplies a local image. The reference Dockerfile includes the expected tools. Network defaults to `on`. The `off` setting uses Docker's `none` network. Commands run through the fixed local Linux Docker socket at `unix:///var/run/docker.sock`.

Cleanup closes open readers and stops this adapter's command groups. The named container and result files survive adapter cleanup. A change to the image, network or user requires explicit owner recreation of the labeled container. Recreating it preserves the bind-mounted workspace and discards container-local files.

On macOS the engine must already serve the fixed socket and share the owner-allocated workspace. Files written there must be owned by the host user and writable from both sides. The group reported on the Mac can differ from the group seen in the Linux container.

To run the optional real-engine check after a frozen install, set `VELA_TEST_DOCKER_IMAGE` to a suitable local image and run `bun test test/e2e/docker-image.test.ts`. The test uses disposable owner directories, disables networking and removes its own containers. The default offline suite exercises the operations and lifecycle separately. To exercise rollback for an incompatible image, also set `VELA_TEST_DOCKER_VOLUME_IMAGE` to a disposable local derivative declaring `VOLUME ["/vela-test-volume"]`.
