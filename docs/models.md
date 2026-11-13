# Models

Vela talks to models through the [AI SDK](https://ai-sdk.dev). A model is named `provider/id`, for example `openai/gpt-5.5` or `anthropic/claude-opus-4-8`. Four providers are built in (`anthropic`, `openai`, `openrouter`, `deepseek`); others are added in `~/.vela/models.json` or by extensions. A built-in model catalog, generated from pi's, gives the built-in providers their model lists and every known model its context window, output limit, price and thinking levels.

## Setup wizard

Run `vela` interactively without a usable model to start setup, or run `vela setup` to revisit configuration. The wizard verifies the selected model with a minimal request, which may incur a small charge, before saving user-level credentials and settings. DeepSeek uses the built-in provider and defaults to `deepseek/deepseek-flash`; choose **Custom provider** for OpenAI Chat Completions (`openai-completions`), OpenAI Responses (`openai-responses`) or Anthropic Messages (`anthropic-messages`). Enter a provider name, base URL, API key and model ID. Optional JSON headers, context window, image input and reasoning support are saved in `models.json`; the key is saved in `auth.json`. Press Enter on an empty headers or context-window input to preserve its existing value, or use the default for a new provider/model. Image input and reasoning each offer Keep, Yes and No. Escape cancels setup at any optional input without saving. Headers and API keys are masked during entry. Verification uses the selected protocol and headers before anything is saved. Cancel leaves existing configuration unchanged; a failed verification can be retried. Existing environment variables and the manual configuration below remain supported.

## Selecting a model

The CLI uses the first of these that is set:

1. `--model provider/id` on the command line.
2. `VELA_MODEL=mock` or `VELA_MODEL=faux:<file>` (see [Offline models](#offline-models)).
3. The model saved with a resumed session (`-c`, `-r`, `--session`, `/resume`).
4. `defaultModel` in [settings](settings.md).
5. `openai/$OPENAI_API_MODEL_NAME`, when that variable is set.
6. The default model of the first built-in provider that has a credential, in the order `anthropic` (`claude-opus-4-8`), `openai` (`gpt-5.5`), `openrouter` (`moonshotai/kimi-k2.6`), `deepseek` (`deepseek-flash`); else the first available model. The first three retain pi's preference order.

If none applies, interactive Vela starts the setup wizard and leaves the `/model` guidance out while it runs; cancelling it brings the hint back. Print mode exits with code 1 and points to `vela setup`; RPC and serve keep their existing behavior.

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
| `deepseek` | `openai-responses` | `DEEPSEEK_API_KEY` | API key |

Their models come from the built-in catalog. A provider without a credential fails when its model is used, with a message naming `/login`, the variable and `models.json`. For an OpenAI-compatible service that only speaks Chat Completions, set `"api": "openai-completions"` on `openai` in `models.json`, or add it as its own provider.

With the `web` extension enabled, built-in OpenAI Responses and Anthropic Messages models and DeepSeek `deepseek-v4-pro` can use provider-hosted web search with an API key. DeepSeek `deepseek-flash` does not declare it. OAuth, other custom providers and other protocols do not declare hosted search by default. A `deepseek` provider URL override retains its declared capabilities; disable `compat.hostedTools` at model level if the gateway does not support search. For OpenAI Responses with effective minimal reasoning, Vela conservatively keeps an independent search provider if configured; OpenAI documents that GPT-5 native web search requires higher reasoning. This policy also applies to opted-in custom Responses endpoints. Search calls may have separate provider charges which are not included in Vela's token cost estimate. See [web search availability and fallback](built-in-extensions.md#web).

Built-in DeepSeek uses Responses rather than pi's Chat Completions so `deepseek-v4-pro` can use native search. Its compatibility defaults are `store: false`, `supportsDeveloperRole: false` and `deepseekReasoningStream: true`. [DeepSeek's Responses API](https://api-docs.deepseek.com/guides/responses_api/) is stateless: the SDK serializes earlier assistant answers and function call/result pairs inline. Plaintext reasoning is streamed and saved, but reasoning-history replay remains unsupported. These defaults also apply when the built-in provider uses a gateway URL.

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
      "apiKey": "$DEEPSEEK_API_KEY",
      "models": [{ "id": "deepseek-flash", "name": "DeepSeek (work)" }]
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
| `baseUrl` | API base URL. Without it Vela uses the official endpoint. Built-in OpenAI also supports `OPENAI_API_BASE_URL`. Vela does not implicitly use the SDK's `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`. |
| `apiKey` | A literal key, or `$NAME` / `${NAME}` to read an environment variable. Local servers that ignore the key still need a placeholder value. A provider without a key is not listed in `/model`. |
| `headers` | Extra HTTP headers. Values support `$NAME` / `${NAME}`. |
| `compat` | Explicit wire compatibility settings. `hostedTools: ["web_search"]` opts in to native search, `store: false` requests stateless Responses, and `includeWebSearchSources: false` omits the optional sources include. See [compatibility flags](#compatibility-flags). A model's fields override the provider's. |
| `models` | Known models with metadata. Optional: unlisted ids still work. |

`$$` is a literal `$`. An unset variable becomes an empty string, so an `apiKey` that points to an unset variable counts as missing.

An entry named `anthropic`, `openai`, `openrouter` or `deepseek` overrides the built-in provider field by field and adds models to the catalog's list. A listed model id that the catalog knows keeps the catalog's metadata, with your fields on top:

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
| `compat` | Per-model overrides for the provider's `compat` fields. |
| `name` | Display name in `/model`. |
| `contextWindow` | Context window in tokens. Sets the compaction thresholds and input cap, and the context percentage in the footer. |
| `maxTokens` | Output token limit. |
| `reasoning` | Whether the model supports thinking; see [Thinking levels](#thinking-levels). |
| `thinkingLevelMap` | Per-level provider values, with `null` for a level the model doesn't support (pi's field); see [Thinking levels](#thinking-levels). |
| `input` | `["text"]` or `["text", "image"]`. |
| `cost` | Prices in dollars per million tokens: `input`, `output`, `cacheRead`, `cacheWrite`. Used for the cost in `/usage` and the footer. |

A model id that is not listed in `models.json` takes its metadata from the catalog when the catalog knows that id, first under the same provider and then under any provider (so `deepseek/deepseek-flash` above gets DeepSeek's context window and price). A model the catalog doesn't know has no cost: `/usage` and the footer show its tokens without a dollar amount.

### Compatibility flags

Compatibility is explicit, not inferred from a hostname or model ID. Provider defaults merge with a provider override field by field; model defaults merge with model overrides the same way. The effective model fields then override provider fields, including explicit `false` and `[]`. For example, setting only `includeWebSearchSources` on the built-in DeepSeek provider keeps its three other defaults. To turn off v4-pro search, set `compat.hostedTools: []` on its model entry.

| Field | Effect |
|---|---|
| `hostedTools` | `["web_search"]` opts into provider-hosted search; `[]` disables it. Supported by Responses and Anthropic Messages, not Chat Completions. |
| `store` | Responses request default. `false` keeps history inline instead of referencing stored provider items. An explicit per-request `providerOptions.openai.store` takes precedence. |
| `supportsDeveloperRole` | Responses only; `false` keeps the system prompt as `system`. Omitted or `true` leaves the SDK's role selection unchanged. Explicit `providerOptions.openai.systemMessageMode` takes precedence. |
| `deepseekReasoningStream` | Responses only; `true` recovers `response.reasoning_text.delta` events the OpenAI SDK drops. Omitted or `false` leaves the SDK stream unchanged. |
| `includeWebSearchSources` | Responses request default for including search sources; `false` omits the optional sources include. Explicit per-request options win. |

`supportsDeveloperRole` follows pi-ai 1.1.0's `OpenAIResponsesCompat` (`src/types.ts:890–892`, `src/api/openai-responses-shared.ts:214–215`). `deepseekReasoningStream` is a Vela adapter flag: pi parses plaintext reasoning directly (`src/api/openai-responses-shared.ts:625`), while Vela must recover it from the SDK's raw stream. `store` and the hosted-search fields reuse Vela's existing Responses integration; pi's completions `thinkingFormat` controls a different request shape and is not used here.

### Migrating existing DeepSeek configurations

An existing provider named `deepseek` retains its explicit `api`, `baseUrl`, key, headers and listed models. Responses entries inherit the built-in compatibility defaults. An explicit Chat Completions override remains Chat Completions, without inherited v4-pro hosted search; remove that `api` override to use the new default Responses path. Vela does not rewrite `models.json` or change saved model references. Existing model IDs are not renamed; their availability remains up to the provider.

**Providers with another name must opt in.** The former exact-`api.deepseek.com` behavior is removed. If a provider such as `openai` or `my-deepseek` relied on that hostname to get DeepSeek compatibility, add the following flags before upgrading. Keep its name, key and URL so saved sessions continue to resolve the same model. The same configuration works behind a different gateway hostname:

```json
{
  "providers": {
    "my-deepseek": {
      "api": "openai-responses",
      "baseUrl": "https://gateway.example/v1",
      "apiKey": "$GATEWAY_API_KEY",
      "compat": {
        "store": false,
        "supportsDeveloperRole": false,
        "deepseekReasoningStream": true
      },
      "models": [
        { "id": "deepseek-flash" },
        { "id": "deepseek-v4-pro", "compat": { "hostedTools": ["web_search"] } }
      ]
    }
  }
}
```

Only declare hosted search if that endpoint/model supports it.

For example, two OpenRouter custom providers can share a key while retaining their original protocol shapes:

```json
{
  "providers": {
    "router-responses": {
      "api": "openai-responses",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "$OPENROUTER_API_KEY",
      "compat": { "hostedTools": ["web_search"], "store": false, "includeWebSearchSources": false },
      "models": [{ "id": "openai/gpt-4.1-mini" }]
    },
    "router-messages": {
      "api": "anthropic-messages",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "$OPENROUTER_API_KEY",
      "headers": { "Authorization": "Bearer $OPENROUTER_API_KEY" },
      "compat": { "hostedTools": ["web_search"] },
      "models": [{ "id": "anthropic/claude-haiku-4.5" }]
    }
  }
}
```

Gateway availability, routing and charges depend on the selected provider and model. An opt-in does not establish that the gateway actually uses the upstream provider's search; verify routing and search results. Tests through a gateway do not establish live verification against direct provider endpoints.

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

A change applies from the next model request, including while the agent is running.

The level is saved with the session and restored on resume; `--thinking` wins over the saved value. Each provider maps `reasoning` to its own options through the AI SDK; OpenRouter receives it as `reasoning: { effort }`.

Like pi, a level the model doesn't support is clamped to the nearest supported one instead of failing:

- A model with `reasoning: false` supports only `off`.
- A reasoning model supports `minimal` to `high`. `xhigh` and `max` are supported only when its `thinkingLevelMap` names them, and a level mapped to `null` is not supported.
- A model with no metadata supports every level.

The clamp looks for the next higher supported level first, then lower. `/thinking` lists the supported levels and says when the level you picked was clamped; the session records the level actually used, and switching models clamps again.

For `openai-responses` providers loaded from configuration, Vela uses the effective model metadata (your merged model entry, then the catalog) before the SDK serializes the request. `reasoning: true` enables the SDK's reasoning path even for an unfamiliar model id. False or missing metadata leaves the SDK's own capability inference unchanged. String values in `thinkingLevelMap` map the selected level to `reasoning.effort`; missing values retain the generic effort (`off` uses `none`). Explicit `providerOptions.openai.forceReasoning` and `reasoningEffort` take precedence. Native OpenAI model-specific effort validation still applies.

For Responses, `compat.supportsDeveloperRole: false` defaults to the `system` role: [DeepSeek treats `developer` as `user`](https://api-docs.deepseek.com/guides/responses_api/). Explicit `systemMessageMode` wins; ChatGPT OAuth's request rules remain authoritative. Other protocols keep their existing role behavior.

This does not establish complete DeepSeek Responses compatibility. With the installed SDK, forcing reasoning filters `temperature` and `topP` for unfamiliar IDs even with effort `none`, and `store: false` adds `reasoning.encrypted_content` to `include`. DeepSeek documents encrypted reasoning and that include field as unsupported. With `compat.deepseekReasoningStream: true`, plaintext deltas are displayed and saved. Reasoning replay remains unsupported; live API verification is still needed for endpoint-specific behavior.

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
