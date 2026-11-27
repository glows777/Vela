# Examples

- [sdk/](sdk/): embedding Vela with `createVela()` / `createRuntime()`: a minimal session, events, concurrent sessions and custom session storage.
- [extensions/](extensions/): one small extension per extension API: tools, commands, prompt sections, tool call and result hooks, providers and channels.

The SDK examples run offline, with the scripted faux model or `VELA_MODEL=mock`. The extension examples load offline with `VELA_MODEL=mock`, but the demo model doesn't call their tools; use a real model to see the model use them. `local-provider.ts` also needs an [Ollama](https://ollama.com) server. Run the examples from the repository root, for example `bun examples/sdk/01-minimal.ts`.
