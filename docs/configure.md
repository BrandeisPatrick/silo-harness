# Configure Silo Harness from a file or the command line

Silo Harness works with any service that speaks the OpenAI chat-completions API: OpenRouter, Portkey, OpenAI, Anthropic, Groq, DeepSeek, Together, Ollama, LM Studio, or a gateway of your own. You can set all of it in Settings, or in a plain file, `~/.silo-harness/settings.json`, or with the `silo` command. The file and the command are made so that a coding agent (Claude Code, Codex, …) can do the setup for you: ask it to "set Silo Harness up for OpenRouter" and point it at [For coding agents](#for-coding-agents).

The running app reads the file again within a second of a change; nothing needs a restart.

- [Shortest working examples](#shortest-working-examples)
- [The command line](#the-command-line)
- [Reference](#reference)
- [For coding agents](#for-coding-agents)

## Shortest working examples

Each block is a whole `~/.silo-harness/settings.json`. `provider` chooses the provider in use; `providers` names as many as you like. The key comes from an environment variable (`apiKeyEnv`, or the type's usual one); the `env` block of the same file counts, which is the reliable place for it, because the app started from the Dock or Finder does not see what your shell profile exports.

### OpenRouter

```json
{
  "$schema": "https://brandeispatrick.github.io/silo-harness/settings.schema.json",
  "env": { "OPENROUTER_API_KEY": "sk-or-…" },
  "provider": "openrouter",
  "providers": {
    "openrouter": { "type": "openrouter", "model": "anthropic/claude-sonnet-4.5" }
  }
}
```

### Portkey with a virtual key

```json
{
  "env": { "PORTKEY_API_KEY": "…" },
  "provider": "portkey-vk",
  "providers": {
    "portkey-vk": { "type": "portkey", "virtualKey": "openai-prod-1a2b3c", "model": "gpt-4o-mini" }
  }
}
```

### Portkey with a config id

```json
{
  "env": { "PORTKEY_API_KEY": "…" },
  "provider": "portkey-routing",
  "providers": {
    "portkey-routing": { "type": "portkey", "config": "pc-fallback-1a2b3c", "model": "gpt-4o-mini", "contextWindow": 128000 }
  }
}
```

The built-in `portkey` block (Settings → Model → the gateway fields) keeps working as before; a named entry is the way to have several Portkey setups side by side.

### Anthropic

```json
{
  "env": { "ANTHROPIC_API_KEY": "sk-ant-…" },
  "provider": "anthropic",
  "providers": {
    "anthropic": { "type": "anthropic", "model": "claude-sonnet-5-5", "contextWindow": 200000 }
  }
}
```

### OpenAI

```json
{
  "env": { "OPENAI_API_KEY": "sk-…" },
  "provider": "openai",
  "providers": {
    "openai": { "type": "openai", "model": "gpt-4.1-mini", "models": ["gpt-4.1-mini", "gpt-4.1"] }
  }
}
```

### Ollama

Ollama on this Mac needs nothing: it is the default. For another machine, or a second Ollama:

```json
{
  "provider": "ollama-box",
  "providers": {
    "ollama-box": { "type": "ollama", "baseURL": "http://192.168.1.20:11434/v1", "model": "qwen3:14b", "numCtx": 32768 }
  }
}
```

### LM Studio

```json
{
  "provider": "lmstudio",
  "providers": {
    "lmstudio": { "type": "lmstudio", "model": "qwen2.5-coder-14b-instruct", "contextWindow": 32768 }
  }
}
```

### Any OpenAI-compatible gateway

```json
{
  "env": { "GATEWAY_TOKEN": "…" },
  "provider": "work",
  "providers": {
    "work": {
      "type": "openai-compatible",
      "label": "Work gateway",
      "baseURL": "https://llm.example.com/v1",
      "apiKeyEnv": "GATEWAY_TOKEN",
      "model": "default",
      "headers": { "X-Team": "platform" },
      "contextWindow": 200000,
      "maxOutput": 8192
    }
  }
}
```

## The command line

`silo` is inside the app: `/Applications/Silo Harness.app/Contents/Resources/bin/silo`. It runs with the app's own Electron, so nothing else has to be installed, and it does not need the app to be running. Settings → General → Command line tool → Install links it as `~/.local/bin/silo` (no administrator password). Before the app was renamed the command was `open-harness`; Install takes away the old link the app made. From a checkout: `node bin/silo.js` (after `npm run build`).

```bash
silo provider add openrouter --type openrouter --model anthropic/claude-sonnet-4.5
silo provider use openrouter
silo provider test
```

| Command | What it does |
| --- | --- |
| `provider list` | Every provider; `*` marks the one in use. |
| `provider add <name> --type <type> [--base-url URL] [--key-env VAR \| --key-stdin] [--model ID] [--models a,b] [--header K=V]… [--label TEXT] [--context-window N] [--max-output N] [--virtual-key VK] [--portkey-config ID] [--portkey-provider SLUG] [--num-ctx N] [--think auto\|on\|off] [--use] [--replace]` | Adds a named provider to your settings.json. `--use` also selects it. |
| `provider remove <name>` | Removes it (and the choice of it, if it was the one in use). |
| `provider use <name> [--model ID]` | Selects it, and sets its model. Works for `ollama` and `portkey` too. |
| `provider test [<name>]` | One tiny chat completion: `ok  OpenRouter · anthropic/claude-sonnet-4.5  (812 ms)`, or the service's error in plain words. |
| `config path` | Where settings.json and config.json are. |
| `config get [<key>]` | What the app uses: one field, or all of them. Keys show as `set` / `not set`. |
| `config set <key> <value>` | Sets a field in settings.json, checked by the app's own rules (`config set theme dark`, `config set maxTurns 60`, `config set dreaming.time 04:30`). |
| `config set <key> --stdin` | For a secret (`portkey.apiKey`, `env.SOME_API_KEY`): the value is read from standard input. |
| `config unset <key>` | Removes a field from settings.json. |
| `doctor` | What the app would use right now (files, provider, base URL, model, whether the key is set) and what is wrong. |

Every command takes `--json` (`{"ok": true, …}` or `{"ok": false, "error": "…"}`) and `--help`. The exit code is 0 on success, 1 when something is wrong, 2 for a mistake in the command itself, with a one-line reason.

A key is never taken from a command-line argument, which would stay in your shell history: `--key-env VAR` names the variable that holds it, and `--key-stdin` reads it from standard input (`pbpaste | silo provider add openrouter --type openrouter --key-stdin`, or type it at the prompt, where it is not shown) and stores it as `apiKey` in your settings.json.

The command writes only your settings.json, atomically, keeping every key it does not know about, in two-space JSON. `SILO_HARNESS_CONFIG_DIR` moves the folder it uses, as it does for the app; `SILO_HARNESS_USER_DATA` tells it where the app's data folder (with config.json) is, if not in the usual place.

## Reference

### Where settings live

| File | What it is |
| --- | --- |
| `~/.silo-harness/settings.json` | Yours. Always applied. The command line writes here. |
| `<project>/.silo-harness/settings.json` | A project's. Applied only once you trust it in Settings → Configuration files; an edit withdraws the approval. Wins over yours. |
| `~/Library/Application Support/Silo Harness/config.json` | What the window's Settings write. |

Precedence: defaults < config.json < your settings.json < the project's. A field a file sets is read-only in Settings and is never written into config.json. A value of the wrong type, or an unknown key, is skipped and reported (in Settings → Configuration files, in `silo doctor`); the rest of the file still applies. `${VAR}` and `${VAR:-default}` are expanded in every string. The schema, for editors and agents: [settings.schema.json](https://brandeispatrick.github.io/silo-harness/settings.schema.json) (put it in `"$schema"`).

### Providers

`"provider"` is the name of the provider in use: `ollama` (the `ollama` block), `portkey` (the `portkey` block, any gateway) or a key of `"providers"`. The names `ollama` and `portkey` cannot be used for a named entry.

| Type | Label | Base URL | Key variable | Source |
| --- | --- | --- | --- | --- |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` | [quickstart](https://openrouter.ai/docs/quickstart) |
| `portkey` | Portkey | `https://api.portkey.ai/v1` | `PORTKEY_API_KEY` | [API reference](https://portkey.ai/docs/api-reference/inference-api/introduction) |
| `openai` | OpenAI | `https://api.openai.com/v1` | `OPENAI_API_KEY` | [API reference](https://developers.openai.com/api/reference/overview) |
| `anthropic` | Anthropic | `https://api.anthropic.com/v1/` | `ANTHROPIC_API_KEY` | [OpenAI SDK compatibility](https://platform.claude.com/docs/en/api/openai-sdk) |
| `groq` | Groq | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` | [OpenAI compatibility](https://console.groq.com/docs/openai) |
| `deepseek` | DeepSeek | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | [first API call](https://api-docs.deepseek.com/) |
| `together` | Together AI | `https://api.together.ai/v1` | `TOGETHER_API_KEY` | [OpenAI compatibility](https://docs.together.ai/docs/openai-api-compatibility) |
| `ollama` | Ollama | `http://localhost:11434/v1` | none | [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) |
| `lmstudio` | LM Studio | `http://localhost:1234/v1` | none | [OpenAI endpoints](https://lmstudio.ai/docs/app/api/endpoints/openai) |
| `openai-compatible` | OpenAI-compatible | none: `baseURL` is required | none unless `apiKeyEnv` or `apiKey` | |

OpenRouter entries also send `HTTP-Referer` and `X-OpenRouter-Title` (OpenRouter's app attribution); an entry's own `headers` win.

Fields of an entry (only `type` is required):

| Field | Types | What it is |
| --- | --- | --- |
| `type` | all | One of the types above. |
| `label` | all | How the window names it. Default: the type's label (with the entry's name when two entries share a type). |
| `baseURL` | all | Overrides the type's endpoint; required for `openai-compatible`. |
| `apiKeyEnv` | all | The variable that holds the key. Default: the type's. Naming one makes the key required. |
| `apiKey` | all | The key itself. Allowed in your settings.json and config.json; ignored, with a problem line, in a project's file. |
| `model` | all | The model to run. |
| `models` | all | Models to offer in the model picker. The window also asks the service (`GET /models`) where it can. |
| `headers` | all | Extra request headers, `"Name": "value"`; `${VAR}` is expanded. |
| `contextWindow` | all | The model's window in tokens (default 128000): the context meter and auto-compaction go by it. For `ollama`, `numCtx` is the window instead. |
| `maxOutput` | all | The most tokens one reply may have, sent as `max_tokens`. Default: the service decides. |
| `virtualKey`, `config`, `provider` | `portkey` | `x-portkey-virtual-key`, `x-portkey-config`, `x-portkey-provider`. With `provider`, put the upstream key in `headers` as `"Authorization": "Bearer ${UPSTREAM_KEY}"`. |
| `numCtx`, `think` | `ollama` | `num_ctx` (also the context window) and the thinking mode, as in the `ollama` block. An `ollama` entry uses Ollama's native API, like the block. |
| `effort` | all but `ollama`, `lmstudio` | Reasoning effort: `low`, `medium`, `high`, `xhigh` or `max`. Unset: the model's default. See [Effort](#effort). |

A bad field is skipped and reported; an entry without a usable `type`, or an `openai-compatible` one without `baseURL`, is skipped whole. A missing key is an error that names the variable to set, shown in Settings, under the chat bar and by `silo doctor`.

What the model can do (images, tools) is detected for Ollama; for the other services it is unknown, so the app does not refuse an image it cannot be sure about.

### Effort

The pill after the model under the chat bar sets the reasoning effort of the provider in use (stored as its entry's `effort`; `/effort <level>` does the same, `/effort default` clears it). It applies from the next model request, sub-sessions included; titles, compaction summaries and Auto mode's check keep their own settings.

- Anthropic: sent as `output_config.effort`, for the models that take it (Claude Opus 4.6 and later, Sonnet 4.6 and later, Haiku 5.5, Fable, Mythos). A level the model lacks runs as the nearest one (`xhigh` on the 4.6 models runs as `high`). Where the app turns thinking off, `xhigh` and `max` turn it on, since the API refuses the pair.
- OpenRouter: `reasoning.effort`. OpenAI, Groq, DeepSeek, Together, Portkey and OpenAI-compatible services: `reasoning_effort`. There the levels are Default (nothing sent), Low, Medium and High. A service that refuses the field gets the request again without it, and the window says so once.
- Ollama keeps its own Thinking setting; LM Studio documents no effort field. No pill for either, or for the built-in Gateway block.

Changing the effort re-writes the cached prompt once, so the app never changes it on its own.

### Keys

- Keys never appear in the window (Settings shows "Set (OPENROUTER_API_KEY)" or "Not set"), in logs, in the transcript, in what mods can read, or in the command's output.
- A key in the `env` block is in the app's environment, so the commands the agent runs see it too. A key stored as `apiKey` (what `--key-stdin` does) is not.
- A project's settings.json (applied only once you trust it) can define providers and choose one, but a repository must not carry, override or redirect a secret. In a project's file:
  - a key is never accepted: `apiKey`, `portkey.apiKey`, `portkey.providerApiKey`, and `env` variables whose names end in `KEY`, `TOKEN`, `SECRET` or `PASSWORD` are ignored with a problem line;
  - the variable that holds the key is never chosen there: `apiKeyEnv` is ignored with a problem line and the type's usual variable is used (`OPENAI_API_KEY` for `openai`, …); an `openai-compatible` entry applies without a key;
  - a service that takes a key (any type but `ollama`, `lmstudio` and `openai-compatible`) keeps its documented address: an entry that sets its own `baseURL` is skipped whole;
  - a header value may not contain a `${VAR}` reference;
  - the built-in gateway block's `portkey.baseURL` is ignored (the gateway key would follow it); `portkey.model`, `virtualKey`, `provider` and `configId` still apply, since they go to the address you chose;
  - a `baseURL` for `ollama` or `lmstudio` (no key) is fine. For a provider with another variable or address, define it in your own settings.json and select it from the project with `"provider"`.

### The browser

The `browser` block is what Settings → Browser edits.

| Field | Default | What it is |
| --- | --- | --- |
| `keepCookies` | `true` | Keep the Browser pane's cookies and site data when the app quits; `false` clears them at quit. |
| `downloadsDir` | `""` | Where the pane's downloads are saved (`~` allowed); empty is the Downloads folder. |
| `openChatLinksInPane` | `false` | Web links (http, https) clicked in the chat open in a new tab of the pane instead of the default browser. |
| `alwaysAllowed` | `[]` | Sites the agent may read and act on without the site card: what "Always allow example.com" saves (`https://example.com`, `http://localhost:3000`, `file:/path`), or a pattern (`*.example.com`). An entry covers only its scheme; one without a scheme covers https only, and http too on `localhost`, `127.0.0.1` and `[::1]`. A sensitive site still asks before acting. |
| `sensitive` | `[]` | Your own sites that always ask before the agent acts, beside the built-in list: `host` (and its subdomains), `*.host`, `host:port`, or a prefix such as `login.`. |
| `exempt` | `[]` | Your own hosts the agent may use with no card and where it may type test passwords, beside `localhost`, `127.0.0.1`, `[::1]`, `*.localhost` and `*.test`: `host`, `*.host`, `host:port`, or a folder (`/path`, `~/path`) whose files count. |

```json
{
  "browser": { "keepCookies": true, "openChatLinksInPane": true, "exempt": ["myapp.local:8080"], "sensitive": ["intranet.example.com"] }
}
```

**A project's settings.json may not set `alwaysAllowed` or `exempt`**: they decide where the agent acts without asking you, which a repository must not choose. They are ignored there with a problem line; add sites in Settings → Browser or in your own settings.json. The rest of the block applies from a trusted project's file. The saved permission answers, the zoom per site and the downloads list are the browser's own files in the data folder, not settings.

### Auto mode

The `autoMode` block tells Auto mode's safety check about your setup (see [Auto mode](reference.md#auto-mode)).

| Field | Default | What it is |
| --- | --- | --- |
| `environment` | `""` | Free text the check reads: which accounts, clusters and hosts are what, e.g. "aisolutions-dev is a dev AWS account". |
| `allow` | `[]` | Plain-language rules the check allows, e.g. "Deploys to staging", "Deleting pods in the dev namespace". |
| `model` | `""` | The check's model: `"<provider>:<model>"` with a provider of Settings → Model or `providers`, or a model id of the session's provider. Empty: the session's own model. |
| `learn` | `true` | Record your answers on approval cards and give them to the check (Settings → Permissions → Auto mode → Learn from my answers). |

```json
{
  "autoMode": {
    "environment": "aisolutions-dev is a dev AWS account; the staging cluster is disposable.",
    "allow": ["Deploys to staging", "terraform apply in infra/dev"],
    "model": "openrouter:anthropic/claude-haiku-4.5"
  }
}
```

**Only your own settings.json may set `autoMode`.** A project's file may not, since a repository could otherwise allow its own actions or send your conversation to a model of its choosing; it is ignored there with a problem line.

### Prices

The cost estimate (see [Cost](reference.md#cost)) knows Claude's list prices on Anthropic's own API. For any other model, or to override those, set `prices`: dollars per million tokens, by model id. `cacheRead` and `cacheWrite` are optional and default to the input price. A project's file replaces the whole table.

```json
{
  "prices": {
    "qwen3:8b": { "input": 0, "output": 0 },
    "example-model": { "input": 1, "output": 5, "cacheRead": 0.1 }
  }
}
```

### The other settings

`permissionMode`, `maxTurns`, `sendScreenshotsToModel`, `systemPromptExtra`, `theme`, `autoTitles`, `autoCompact`, `compactThreshold`, `pruneToolResults`, `toolSet`, `toolActivity`, `notifications`, `keepAwake`, `historyTrashDays`; the `ollama` block (`baseURL`, `model`, `numCtx`, `think`), the `portkey` block (`baseURL`, `apiKey`, `model`, `virtualKey`, `provider`, `providerApiKey`, `configId`, `contextWindow`), `dreaming` (`daily`, `time`, `mode`, `skills`, `mods`, `memory`); `browser` (see [The browser](#the-browser)); `env`; `hooks`, commands run before and after the agent acts, in Claude Code's format (a project's run only once you trust its file; see [hooks.md](hooks.md)), and `disableAllHooks`; and in your own file `workingDirectory`, the folder the app opens in. The schema has the allowed values of each.

`toolConcurrency` (1 to 10, default 4): how many read-only tool calls of one reply run at the same time; `1` runs every call one after another. See [latency.md](latency.md).

`timingLog` (or `SILO_TIMING=1` in the environment) appends each run's timing, numbers only, to `timing/timing.jsonl` in the app's data folder; `/timing` shows the last run's without it. See [latency.md](latency.md).

## For coding agents

You are setting up Silo Harness for the person you work with. Do it with the `silo` command; edit `~/.silo-harness/settings.json` by hand only if the command is not available, and then keep every key that is already in the file.

1. Find the command. In order: `silo` on the PATH; `/Applications/Silo Harness.app/Contents/Resources/bin/silo`; in a checkout of the repository, `node bin/silo.js` after `npm run build`. Check it with `silo --help`.
2. See what is there: `silo doctor --json` and `silo provider list --json`.
3. Add the provider the person asked for, with the type from the table in [Providers](#providers) (use `openai-compatible` with `--base-url` for anything else) and the model they want:
   `silo provider add openrouter --type openrouter --model anthropic/claude-sonnet-4.5 --use --json`
4. The key. Ask the person; never invent one. If it is already in an environment variable the app can see, name it with `--key-env VAR`. Otherwise have them store it without showing it to you: they run `silo provider add … --key-stdin --replace` themselves and paste the key at the prompt, or put it in the `env` block of `~/.silo-harness/settings.json`. Remember that the app opened from the Dock does not see variables exported in a shell profile.
5. Check it: `silo provider test --json`. `"ok": true` with the model and the time means the app can use it. Otherwise the `error` says what the service answered (a refused key, an unknown model, an unreachable address); fix that and test again.
6. Tell the person what you set: the provider name, the model, and that the app has picked it up already (it re-reads the file within a second).

Never:

- put a key in a project's `.silo-harness/settings.json`, in a repository, in a commit, or in any file other than the person's own `~/.silo-harness/settings.json`;
- pass a key as a command-line argument, or print, echo or log one (no `cat ~/.silo-harness/settings.json` when it holds keys: use `silo config get` and `doctor`, which never show them);
- invent a base URL for a service: use the type, or the URL the person or the service's documentation gives;
- edit `config.json` while the app is running (the window owns it), or remove keys you did not add.
