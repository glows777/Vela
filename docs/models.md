# Models

Vela talks to models through the [AI SDK](https://ai-sdk.dev). A model is named `provider/id`, for example `openai/gpt-5.5` or `anthropic/claude-opus-4-8`. Three providers are built in (`anthropic`, `openai`, `openrouter`); others are added in `~/.vela/models.json` or by extensions. A built-in model catalog, generated from pi's, gives the built-in providers their model lists and every known model its context window, output limit, price and thinking levels.

## Selecting a model

The CLI uses the first of these that is set:

1. `--model provider/id` on the command line.
2. `VELA_MODEL=mock` or `VELA_MODEL=faux:<file>` (see [Offline models](#offline-models)).
3. The model saved with a resumed session (`-c`, `-r`, `--session`, `/resume`).
4. `defaultModel` in [settings](settings.md).
5. `openai/$OPENAI_API_MODEL_NAME`, when that variable is set.
6. The default model of the first built-in provider that has a credential, in the order `anthropic` (`claude-opus-4-8`), `openai` (`gpt-5.5`), `openrouter` (`moonshotai/kimi-k2.6`); else the first available model. These are pi's defaults.

If none applies (no provider has a credential), Vela says how to sign in or set a key. In interactive mode it still opens so you can run `/login`; in print mode it exits with code 1.

Inside a session:

- `/model` (or Ctrl+L) opens a searchable picker of the available models: those of providers that have a credential (like pi). Type to filter.
- `/model provider/id` switches directly, listed or not.
- Ctrl+P and Shift+Ctrl+P cycle forward and back through the models in `enabledModels` (see [Settings](settings.md#enabled-models)), or through all available models when it is not set.
- The choice applies to the current session from the next prompt and is saved with it. It does not change `defaultModel`.

`vela --list-models` prints the available models.

The part after the first `/` is the model id, so ids that contain `/` work: `openrouter/anthropic/claude-x` is provider `openrouter`, id `anthropic/claude-x`.

## Built-in providers

| Provider | API | Environment variable | Sign in with `/login` |
|---|---|---|---|
| `anthropic` | `anthropic-messages` | `ANTHROPIC_API_KEY` | API key |
| `openai` | `openai-responses` (Responses API) | `OPENAI_API_KEY`; base URL `OPENAI_API_BASE_URL` | Sign in with ChatGPT, or API key |
| `openrouter` | `openai-completions` | `OPENROUTER_API_KEY` | OpenRouter sign-in (creates a key), or API key |

Their models come from the built-in catalog. A provider without a credential fails when its model is used, with a message naming `/login`, the variable and `models.json`. For an OpenAI-compatible service that only speaks Chat Completions, set `"api": "openai-completions"` on `openai` in `models.json`, or add it as its own provider.

For `openai-responses` endpoints whose hostname is exactly `api.deepseek.com`, Vela sets `providerOptions.openai.store: false` before SDK serialization. [DeepSeek's Responses API](https://api-docs.deepseek.com/guides/responses_api/) is stateless and does not support server-side item references. This option lets the SDK send earlier assistant answers inline, retaining their phase and ordinary function call/result pairs without manually rewriting history. Local history, user messages and other providers are unchanged. This does not fix reasoning-event parsing or establish complete reasoning-history replay support.

## Credentials and /login

A provider's key is looked up per request, in this order (pi's):

1. The credential stored by `/login` in `~/.vela/auth.json`.
2. `apiKey` in `models.json`.
3. The provider's environment variable.

`/login` lists the providers you can sign in to and how; `/login <provider>` picks one directly. It stores either an API key you type or an OAuth credential. `/logout <provider>` removes the stored credential; environment variables and `models.json` are left alone.

`auth.json` uses pi's format (`{ "<provider>": { "type": "api_key", "key": "…" } }` or `{ "type": "oauth", "access", "refresh", "expires", … }`). It is created with mode 0600 in a 0700 directory. Treat it like a password file.

OAuth access tokens with less than 5 minutes left are refreshed before the request. The refresh holds a lock file (`auth.json.lock`), so several Vela processes sharing the file refresh once. A failed refresh fails the request with a message asking you to run `/login <provider>` again; it does not fall back to an environment variable.

### Sign in with ChatGPT

`/login openai` → **Sign in with ChatGPT** uses your ChatGPT Plus or Pro plan instead of API billing, through OpenAI's [token sharing for open-source agents](https://developers.openai.com/siwc/token-sharing-open-source/sign-in). No app registration is needed: the first sign-in registers this installation (its id is in `~/.vela/installation-id`) and later sign-ins reuse it.

Vela opens the browser and waits for the redirect on `http://127.0.0.1:1455/auth/callback`. When the browser runs on another machine, paste the final redirect URL into Vela instead. Port 1455 is shared with the Codex CLI, so finish or cancel a sign-in there first.

OpenAI documents this sign-in for local agents that the signed-in person runs. Use it only in the terminal on your own machine: not for a Lark bot, a server or any agent that other people talk to. Vela enforces part of this: channel sessions (Lark) that would use the ChatGPT sign-in fail with an error, so give `openai` an API key or pick another model for them.

The token is only sent to `https://api.openai.com`: with `OPENAI_API_BASE_URL` (or an `openai` `baseUrl` in models.json) pointing elsewhere, requests fail instead of sending your ChatGPT token to that server.

The plan route accepts fewer request options than the API: Vela sends requests without stored responses or a system role and drops options such as the output token limit and temperature.

### OpenRouter

`/login openrouter` → **OpenRouter** opens OpenRouter in the browser and stores the API key it creates for Vela. Like an API key you type, it does not expire; revoke it in your OpenRouter settings.

## models.json

`~/.vela/models.json` adds providers or changes the built-in ones. It is read once at startup, from the user directory only; projects cannot add providers.

```json
{
  "providers": {
    "deepseek": {
      "api": "openai-completions",
      "baseUrl": "https://api.deepseek.com",
      "apiKey": "$DEEPSEEK_API_KEY",
      "models": [{ "id": "deepseek-chat" }]
    },
    "ollama": {
      "api": "openai-completions",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "models": [{ "id": "qwen3:8b", "contextWindow": 40960, "reasoning": false }]
    }
  }
}
```

### Provider fields

| Field | Description |
|---|---|
| `api` | Wire protocol, required for new providers: `openai-completions` (OpenAI Chat Completions), `openai-responses` (OpenAI Responses API) or `anthropic-messages` (Anthropic Messages API). |
| `baseUrl` | API base URL. Without it the AI SDK default applies (the official endpoint, or `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` if set). |
| `apiKey` | A literal key, or `$NAME` / `${NAME}` to read an environment variable. Local servers that ignore the key still need a placeholder value. A provider without a key is not listed in `/model`. |
| `headers` | Extra HTTP headers. Values support `$NAME` / `${NAME}`. |
| `models` | Known models with metadata. Optional: unlisted ids still work. |

`$$` is a literal `$`. An unset variable becomes an empty string, so an `apiKey` that points to an unset variable counts as missing.

An entry named `anthropic`, `openai` or `openrouter` overrides the built-in provider field by field and adds models to the catalog's list. A listed model id that the catalog knows keeps the catalog's metadata, with your fields on top:

```json
{
  "providers": {
    "openai": {
      "models": [{ "id": "gpt-5.5", "name": "GPT (work)", "contextWindow": 272000 }]
    }
  }
}
```

### Model fields

| Field | Description |
|---|---|
| `id` | Model id sent to the provider. Required. |
| `name` | Display name in `/model`. |
| `contextWindow` | Context window in tokens. Sets the compaction thresholds and input cap, and the context percentage in the footer. |
| `maxTokens` | Output token limit. |
| `reasoning` | Whether the model supports thinking; see [Thinking levels](#thinking-levels). |
| `thinkingLevelMap` | Per-level provider values, with `null` for a level the model doesn't support (pi's field); see [Thinking levels](#thinking-levels). |
| `input` | `["text"]` or `["text", "image"]`. |
| `cost` | Prices in dollars per million tokens: `input`, `output`, `cacheRead`, `cacheWrite`. Used for the cost in `/usage` and the footer. |

A model id that is not listed in `models.json` takes its metadata from the catalog when the catalog knows that id, first under the same provider and then under any provider (so `deepseek/deepseek-chat` above gets DeepSeek's context window and price). A model the catalog doesn't know has no cost: `/usage` and the footer show its tokens without a dollar amount.

An invalid file (bad JSON, unknown `api`, a model without `id`) stops the CLI with a `[config]` error.

## The model catalog

`packages/core/src/models/catalog.generated.ts` is generated from a pinned version of pi's `@earendil-works/pi-ai` package (MIT), keeping the providers and fields Vela uses. It is part of the package, so Vela has no runtime dependency on pi. To refresh it, run `bun scripts/update-models.ts [version]` and commit the result.

## Context window and limits

When the model has a `contextWindow`, Vela derives its compaction thresholds and input cap from it instead of assuming a 200k window, and recomputes them when you switch models. Without `contextWindow` the defaults apply and the footer assumes 200k. Values set under `limits` always win. The formulas are in [Settings](settings.md#limits); compaction itself is described in [Sessions](sessions.md#compaction).

## Thinking levels

The thinking level controls how much the model reasons before answering:

| Level | Sent to the AI SDK as `reasoning` |
|---|---|
| `off` | `none` (nothing for a model with `reasoning: false`) |
| `minimal`, `low`, `medium`, `high`, `xhigh`, `max` | the same value |

The default is `medium`. Set it with:

- `--thinking <level>` for this run,
- `defaultThinkingLevel` in [settings](settings.md) for new sessions,
- `/thinking [level]` or Shift+Tab (cycles through the levels the model supports) in the terminal UI.

The level is saved with the session and restored on resume; `--thinking` wins over the saved value. Each provider maps `reasoning` to its own options through the AI SDK; OpenRouter receives it as `reasoning: { effort }`.

Like pi, a level the model doesn't support is clamped to the nearest supported one instead of failing:

- A model with `reasoning: false` supports only `off`.
- A reasoning model supports `minimal` to `high`. `xhigh` and `max` are supported only when its `thinkingLevelMap` names them, and a level mapped to `null` is not supported.
- A model with no metadata supports every level.

The clamp looks for the next higher supported level first, then lower. `/thinking` lists the supported levels and says when the level you picked was clamped; the session records the level actually used, and switching models clamps again.

For `openai-responses` providers loaded from configuration, Vela uses the effective model metadata (your merged model entry, then the catalog) before the SDK serializes the request. `reasoning: true` enables the SDK's reasoning path even for an unfamiliar model id. False or missing metadata leaves the SDK's own capability inference unchanged. String values in `thinkingLevelMap` map the selected level to `reasoning.effort`; missing values retain the generic effort (`off` uses `none`). Explicit `providerOptions.openai.forceReasoning` and `reasoningEffort` take precedence. Native OpenAI model-specific effort validation still applies.

Responses requests to the exact hostname `api.deepseek.com` default to the `system` role: [DeepSeek treats `developer` as `user`](https://api-docs.deepseek.com/guides/responses_api/). An explicit `systemMessageMode` wins; ChatGPT OAuth's existing request rules remain authoritative. Other protocols keep their existing role behavior. On other Responses hosts, enabling reasoning for an unfamiliar model can change the SDK's default role from `system` to `developer`. Custom endpoints requiring `system` can set the existing `providerOptions.openai.systemMessageMode` request option to `'system'` through a [`before_provider_request` hook](extensions.md#intercepting-events) or model wrapper; there is no general `models.json` field for this option.

This enables thinking controls, not full DeepSeek Responses compatibility. With the installed SDK, forcing reasoning also filters `temperature` and `topP` for unfamiliar model ids, even with effort `none`, and adds `reasoning.encrypted_content` to `include` when `store: false` is used, including the policy enforced for `api.deepseek.com`. DeepSeek documents encrypted reasoning and that include field as unsupported. For `api.deepseek.com`, Vela now parses plaintext reasoning deltas (`response.reasoning_text.delta`) so thinking is displayed and saved in the session. Reasoning replay remains unsupported.

## Extension providers

An extension can register a provider with `vela.registerProvider(name, { models, createModel })`, where `createModel(id, ctx)` returns any AI SDK model. Afterwards `name/<id>` works with `--model`, `defaultModel`, `/model` and `session.setModel()`. A provider can also offer `/login`: `oauth` (an `OAuthLogin` with `login` and `refresh`) or `apiKeyLogin: true`, and reads the stored credential per request with `await ctx.credential()`, which refreshes an expiring OAuth token first. Use this for protocols or authentication that `models.json` cannot express. Provider names are not prefixed with the extension name, and registering a name that already exists is an error. See [Extensions](extensions.md#registerprovider) and `examples/extensions/local-provider.ts`.

## Offline models

| Setting | Model |
|---|---|
| `VELA_MODEL=mock` | `mock/mock-model`, a keyword-driven demo model. It needs no key, calls real tools for some requests (`list files`, `read <file>`, `test bash`, `test edit`) and simulates prompt caching; `/cache on` and `/cache off` toggle the simulation. |
| `VELA_MODEL=faux:<file.json>` | Replays the model responses of a scenario file in order. |
| `VELA_RECORD=<file.json>` | Records the responses of the current model (and your input) into a scenario file for later replay. Works only with models resolved from `models.json` or the built-in providers, not extension providers. |

```bash
VELA_RECORD=bug.json vela -p "reproduce the bug"
VELA_MODEL=faux:bug.json vela -p "reproduce the bug"
```

In code and tests, use the faux model from `@glows777/vela/testing`. See [Testing](testing.md).

## SDK

`createVela({ model, providers, credentials, thinkingLevel, limits })` takes the same pieces. `model` is a `provider/id` string or any AI SDK `LanguageModel`; without it, the default model is picked as in step 6 above. To use the CLI's providers and sign-ins, pass `loadConfig({ env: process.env })`'s `providers` and `credentials` (`fileCredentialStore('~/.vela/auth.json')`); the default `credentials` is `memoryCredentialStore()`, which keeps nothing on disk. `vela.models()` returns the available models (`{ all: true }` for every listed one), and `vela.login()` / `vela.logout()` do what `/login` and `/logout` do. See [SDK](sdk.md).
