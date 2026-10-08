# Models

Vela talks to models through the [AI SDK](https://ai-sdk.dev). A model is named `provider/id`, for example `openai/<model-id>` or `anthropic/<model-id>`. Two providers are built in; others are added in `~/.vela/models.json` or by extensions. Vela has no built-in model catalog: any id the provider accepts works, and `models.json` adds metadata such as the context window and price.

## Selecting a model

The CLI uses the first of these that is set:

1. `--model provider/id` on the command line.
2. `VELA_MODEL=mock` or `VELA_MODEL=faux:<file>` (see [Offline models](#offline-models)).
3. The model saved with a resumed session (`-c`, `-r`, `--session`, `/resume`).
4. `defaultModel` in [settings](settings.md).
5. `openai/$OPENAI_API_MODEL_NAME`, when that variable is set.

If none applies, Vela reports how to choose a model. In interactive mode it still opens so you can pick one with `/model`; in print mode it exits with code 1.

Inside a session:

- `/model` opens a picker of the models listed in `models.json` and by extension providers. The built-in providers list no models, so the picker is empty until you list some.
- `/model provider/id` switches directly, listed or not. Ctrl+L also opens the picker.
- The choice applies to the current session from the next prompt and is saved with it. It does not change `defaultModel`.

The part after the first `/` is the model id, so ids that contain `/` work: `openrouter/anthropic/claude-x` is provider `openrouter`, id `anthropic/claude-x`.

## Built-in providers

| Provider | API | Key | Base URL |
|---|---|---|---|
| `openai` | `openai-completions` (Chat Completions) | `OPENAI_API_KEY` | `OPENAI_API_BASE_URL`, default the OpenAI API |
| `anthropic` | `anthropic-messages` | `ANTHROPIC_API_KEY` | the Anthropic API |

The `openai` provider uses the Chat Completions API so that it works with any OpenAI-compatible service: point `OPENAI_API_BASE_URL` at it. A provider whose key is missing fails when its model is first used, with a message naming the variable.

## models.json

`~/.vela/models.json` adds providers or changes the built-in ones. It is read once at startup, from the user directory only; projects cannot add providers.

```json
{
  "providers": {
    "openrouter": {
      "api": "openai-completions",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "$OPENROUTER_API_KEY",
      "headers": { "X-Title": "Vela" },
      "models": [
        {
          "id": "anthropic/claude-x",
          "name": "Claude via OpenRouter",
          "contextWindow": 200000,
          "reasoning": true,
          "cost": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
        }
      ]
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
| `api` | Wire protocol, required: `openai-completions` (OpenAI Chat Completions), `openai-responses` (OpenAI Responses API) or `anthropic-messages` (Anthropic Messages API). |
| `baseUrl` | API base URL. Without it the AI SDK default applies (the official endpoint, or `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` if set). |
| `apiKey` | Required. A literal key, or `$NAME` / `${NAME}` to read an environment variable. Local servers that ignore the key still need a placeholder value. |
| `headers` | Extra HTTP headers. Values support `$NAME` / `${NAME}`. |
| `models` | Known models with metadata. Optional: unlisted ids still work, without metadata. |

`$$` is a literal `$`. An unset variable becomes an empty string, so an `apiKey` that points to an unset variable counts as missing.

An entry named `openai` or `anthropic` overrides the built-in provider field by field. For example, this keeps the built-in key and URL and only lists models, so `/model` can show them and the context window is known:

```json
{
  "providers": {
    "openai": {
      "models": [{ "id": "gpt-5", "contextWindow": 400000 }]
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
| `reasoning` | `false` means the model does not support thinking; see [Thinking levels](#thinking-levels). |
| `cost` | Prices in dollars per million tokens: `input`, `output`, `cacheRead`, `cacheWrite`. Used for the cost in `/usage` and the footer. |

Without `cost`, Vela looks the model id up in a small built-in price table and otherwise uses placeholder prices, so set `cost` if you rely on the numbers.

An invalid file (bad JSON, unknown `api`, a model without `id`) stops the CLI with a `[config]` error.

## Context window and limits

When the model has a `contextWindow`, Vela derives its compaction thresholds and input cap from it instead of assuming a 200k window, and recomputes them when you switch models. Without `contextWindow` the defaults apply and the footer assumes 200k. Values set under `limits` always win. The formulas are in [Settings](settings.md#limits); compaction itself is described in [Sessions](sessions.md#compaction).

## Thinking levels

The thinking level controls how much the model reasons before answering:

| Level | Sent to the AI SDK as `reasoning` |
|---|---|
| `off` | `none` |
| `minimal`, `low`, `medium`, `high`, `xhigh` | the same value |
| `max` | `xhigh` |

The default is `medium`. Set it with:

- `--thinking <level>` for this run,
- `defaultThinkingLevel` in [settings](settings.md) for new sessions,
- `/thinking [level]` or Shift+Tab (cycles through the levels) in the terminal UI.

The level is saved with the session and restored on resume; `--thinking` wins over the saved value. Each provider maps `reasoning` to its own options through the AI SDK.

If a model entry says `"reasoning": false`, level `off` sends no reasoning option, and any other level makes the turn fail before a request is sent:

```text
Model ollama/qwen3:8b does not support thinking (reasoning: false) but the thinking level is medium; set the thinking level to off (/thinking off, --thinking off, or setThinkingLevel('off'))
```

Because the default is `medium`, use `--thinking off` or `defaultThinkingLevel: "off"` for such models. Models without a `reasoning` field always receive the option; if the provider rejects it, its error is shown as is.

## Extension providers

An extension can register a provider with `vela.registerProvider(name, { models, createModel })`, where `createModel(id)` returns any AI SDK model. Afterwards `name/<id>` works with `--model`, `defaultModel`, `/model` and `session.setModel()`. Use this for protocols or authentication that `models.json` cannot express. Provider names are not prefixed with the extension name, and registering a name that already exists is an error. See [Extensions](extensions.md) and `examples/extensions/local-provider.ts`.

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

`createVela({ model, providers, thinkingLevel, limits })` takes the same pieces. `model` is a `provider/id` string or any AI SDK `LanguageModel`. To use the CLI's providers, pass `loadConfig({ env: process.env }).providers`; `loadModels({ agentDir, env })` builds them from a `models.json` alone. See [SDK](sdk.md).
