# omp-opencode-bridge

An [OMP](https://oh-my-pi.dev) (Oh My Pi) plugin with three capabilities:

1. **OpenCode model bridge** — detect a real [OpenCode](https://github.com/anomalyco/opencode) install, discover its providers/models dynamically (never hardcoded), and expose them in OMP as `opencode-bridge/<provider>/<model>`.
2. **Direct URL providers** — register a model by its `baseURL` and key alone, in the plugin's own config, and infer over plain HTTP as `direct/<provider>/<model>@<credential>`. **No OpenCode involved at all.**
3. **External-plugin audit** — a pre-install static validator for third-party OMP plugins: normalize the manifest, validate it, block path traversal, and surface declared capabilities before you install.

The two model sources are fully independent:

```
OMP
├── opencode-bridge/<provider>/<model>@<credential>
│     → discovered from OpenCode → OpenCode's session API
└── direct/<provider>/<model>@<credential>
      → configured in the plugin's profile file → direct HTTP to baseURL
```

Either can be used without the other. OpenCode being down does not affect direct
providers, and no direct provider is ever written to `opencode.json`.

## Capability boundary (read this first)

This bridge is built only on **verified** OpenCode surfaces — no invented APIs, no TUI scraping.

- **Discovery is fully supported.** `opencode api model.list` returns the real per-model records (capabilities, cost, limits, reasoning variants); the bridge maps them into OMP model configs and never hardcodes a model list.
- **Inference is a *bounded* capability**, and it works. OpenCode exposes a session-based *agent* API, not a raw chat/completions endpoint, so the bridge drives one verified call sequence per request:

  | step | call | note |
  |---|---|---|
  | 1 | `session.create` | the model is pinned here, as `model: { providerID, id }` — `session.prompt` has no model field |
  | 2 | `session.prompt` | **asynchronous**: it enqueues a user message and returns immediately |
  | 3 | `experimental.session.wait` | blocks until the session goes idle; `503` means "still running" and is retried |
  | 4 | `session.message.list` | the actual answer: newest `assistant` message, its `content[].text` parts joined |
  | 5 | `session.remove` | deletes the throwaway session (runs even if a step above failed) |

  A second, faster path runs alongside it when the server supports SSE:

  | step | call | note |
  |---|---|---|
  | a | `GET /api/event` (SSE) | opened **before** the prompt, so the first delta cannot be lost |
  | b | `session.create` → `session.prompt` | as above |
  | c | filter by `sessionID`, translate, emit | `session.text.*` → `text_*`, `session.reasoning.*` → `thinking_*` |
  | d | `session.execution.succeeded` | completion; `session.remove` then cleans up |

  Measured against a live server, the deltas arrive ~180 ms apart — this is genuinely incremental, not a buffered answer wearing a streaming hat.

  Consequences:
  - **Text and reasoning stream incrementally** when the server exposes `GET /api/event` (SSE). The bridge opens that stream itself, filters by session id, and emits OMP's `text_*` / `thinking_*` events as the deltas arrive. `opencode api event.subscribe` is deliberately *not* used: that path spawns a CLI child that blocks forever on an unbounded stream, so it can never return or be cleaned up.
  - **Buffered fallback.** If the event stream cannot be opened (older build, no server, auth mismatch), the bridge silently uses the `wait` + `message.list` path above. Same OMP event sequence, one big delta instead of many. `opencode doctor` reports which transport is live.
  - **Caller-supplied tool schemas are refused, not dropped.** OpenCode drives its own agent tools inside the session; it does not accept an OpenAI/Anthropic tool schema on the wire. Passing `tools` yields a clear capability error.
  - **Reasoning content is exposed; reasoning *effort* is refused.** Reasoning deltas map to OMP's `thinking_start` / `thinking_delta` / `thinking_end` events and a `{type:"thinking"}` content block. Effort, by contrast, is a *variant on the model reference chosen at session-create time*, not a per-request field, so it cannot be forwarded. Reported as unsupported rather than silently ignored.
  - **`temperature` / `maxTokens` / image inputs are refused** — none are fields of `session.create` or `session.prompt`.
  - **Multi-turn history is flattened** into the single `text` blob `session.prompt` accepts, labelled `User:` / `Assistant:`.
- **No sandbox.** OMP loads extensions as ESM **in-process with full host trust**. This plugin cannot contain another plugin at runtime. The audit command is therefore a *pre-install advisory*, not an enforcement boundary. See [DESIGN.md](DESIGN.md) and "Security model" below.

Any request OpenCode cannot honor becomes a `CapabilityError` / stream `error` event — never a silent wrong answer.

### Direct URL providers are a different path

The boundaries above are specific to the OpenCode bridge. A direct provider is a
plain OpenAI-compatible HTTP endpoint, so it has none of those limits: text and
reasoning **stream incrementally** (`text_delta` / `thinking_delta` as each SSE
frame arrives), **tool calling works** in both directions (OMP's tool schemas go
upstream as OpenAI `tools`; returned `tool_calls` come back to OMP), and
`temperature` / `topP` / `maxTokens` are forwarded. `usage` and `finish_reason`
are reported; cancellation aborts the in-flight request. The only refusals are
honest ones — a provider configured `supportsTools: false` will not pretend it
accepts tools, and `openai-responses` will not silently reshaped a tool turn.

## Requirements

- Node.js ≥ 20
- OMP (to use the provider) — the audit CLI works standalone.
- OpenCode on `PATH` (or set `OPENCODE_BIN`) with at least one authenticated provider, for live model discovery/inference.
- OpenCode 2.x for plugin-managed credential profiles (verified with 2.0.12).

## Install

### One command

```
node src/cli.js setup .
```

That packs the plugin, installs it into `~/.omp/plugins/`, and writes the
credential file. Pass your keys inline and it writes them for you:

```
node src/cli.js setup . --key account1=sk-... --key account2=sk-...
```

Then:

```
omp models refresh
```

With no `--key` it writes a commented template and you paste the keys in
yourself. It never overwrites an existing credential file, so re-running it to
update the plugin keeps your keys.

<details>
<summary>What it does, and the alternatives</summary>

**1. Get the plugin**

From npm:

```
omp plugin install omp-opencode-bridge
```

From a local checkout (for development, or if the package is not published),
`setup` is the short form of:

```
npm pack --pack-destination ~/.omp/plugins
cd ~/.omp/plugins && npm install
```

`setup` also creates `~/.omp/plugins/package.json` if it is missing. That
matters: `npm install <tarball>` in a directory with no `package.json` walks
*up* to the nearest project and installs there instead — silently, with exit
code 0 — leaving the store empty. `setup` makes the store a real npm project
and then verifies the files actually landed.

Copying files (rather than symlinking back to the checkout) is deliberate: a
symlink would make the installed plugin change whenever you edit the repo, and
`omp plugin install .` symlinks fail outright on Windows (`EPERM`).

Verify it registered:

```
omp plugins                                  # → omp-opencode-bridge@1.0.0
```

**2. Add your API keys**

The credential file is `opencode-bridge.profiles.yml`, next to the installed
plugin or in `~/.omp`. `setup` writes it for you; if the file was not created,
write it yourself:

```yaml
providers:
  opencode:
    credentials:
      - id: account1
        apiKey: sk-replace-me
```

Put one entry per API key in the `apiKey` field and delete any you don't need.
If the file was not created at all, write it at
`~/.omp/opencode-bridge.profiles.yml`, or point elsewhere with `profilesFile` in
the plugin settings (or the `OPENCODE_BRIDGE_PROFILES_FILE` environment
variable). The lookup order is:

1. `profilesFile` / `OPENCODE_BRIDGE_PROFILES_FILE` — explicit, always wins
2. the installed plugin directory
3. `~/.omp`
4. the current working directory

To keep keys out of the file entirely, name a variable instead:
`apiKeyEnv: OPENCODE_KEY_1` reads the key from the environment.

Check what the bridge found — this never prints a key value:

```
omp-opencode-bridge keys
# opencode/account1   configured
# opencode/account2   placeholder
```

`placeholder` means the entry still holds the template's `sk-replace-me` — it
is a key shape, not a key.

**3. Refresh models and use them**

```
omp models refresh
omp models opencode-bridge
```

</details>

Every discovered model is offered once per profile:

```
opencode-bridge/opencode/space-bunny-free@account1
opencode-bridge/opencode/space-bunny-free@account2
```

Then pick one in OMP, e.g. `omp --model opencode-bridge/opencode/space-bunny-free@account1`.
Each profile runs its own isolated OpenCode server, so switching `@account1` /
`@account2` switches credentials, and concurrent requests on different accounts
never share one.

### Updating

Re-run `node src/cli.js setup .` from the checkout, or re-install the same way
as step 1. Your `opencode-bridge.profiles.yml` lives in `~/.omp` (or the
install dir) and is never touched by an update. Run `omp models refresh`
afterwards if the model list looks stale.

### Uninstall

```
cd ~/.omp/plugins && npm uninstall omp-opencode-bridge
```

Your profile file is left in place, so reinstalling restores your keys.

### Standalone CLI (audit + doctor, no OMP needed)

```
npm install -g omp-opencode-bridge
omp-opencode-bridge doctor
omp-opencode-bridge setup .
omp-opencode-bridge keys
```

## Configuration

Settings live under the plugin's `omp.settings` (configure via OMP's plugin settings UI/file). Env vars override where noted.

| Setting        | Type    | Default | Env              | Meaning |
|----------------|---------|---------|------------------|---------|
| `enabled`      | boolean | `true`  |                  | Register the `opencode-bridge` provider on startup. |
| `opencodePath` | string  | auto    | `OPENCODE_BIN`   | Path to the `opencode` executable. |
| `server`       | string  | auto    | `OPENCODE_SERVER`| Explicit server URL (else `opencode service status`). |
| `discovery`    | boolean | `true`  |                  | Dynamically discover OpenCode providers/models. |
| `inference`    | boolean | `true`  |                  | Forward inference through the session API. |
| `timeoutMs`    | number  | `30000` |                  | Per-request timeout for OpenCode CLI/API calls. |
| `profilesFile` | string  | unset   | `OPENCODE_BRIDGE_PROFILES_FILE` | Credential profile YAML. Unset = auto-discover beside the plugin or in `~/.omp`. |

### Multiple API keys for one OpenCode provider

See [Install](#install) for how the file is created and where it lives. In short:
it sits beside the installed plugin (or in `~/.omp`), never in a source
checkout, so updating or reinstalling keeps your keys. A dynamically discovered
`opencode/gpt-5.6-sol` becomes:

```
opencode-bridge/opencode/gpt-5.6-sol@account1
opencode-bridge/opencode/gpt-5.6-sol@account2
opencode-bridge/opencode/gpt-5.6-sol@account3
```

The suffix selects the credential and is removed before calling OpenCode; the
upstream model remains `opencode/gpt-5.6-sol`. Characters such as `@`, `%`, and
`/` in upstream model IDs are URL-encoded in profiled OMP IDs so IDs cannot
collide. Providers without profiles retain their existing OMP IDs and auth.

For a quick, non-secret status check:

```
omp-opencode-bridge keys
```

Each active profile starts one private OpenCode 2 server on loopback, reused for
later requests. The bridge sets that server's `providers.<provider>.settings.apiKey`
to the selected profile key and removes inherited credential environment
variables so nothing else can supply one. It isolates OpenCode's
data/config directory per process and protects the local
server with a random password. This requires a key-based OpenCode provider that
honors `settings.apiKey`; OAuth or multi-field cloud credentials are outside this
feature. A profile key is read when its server starts, so restart OMP after
changing it. Manual selection is supported; automatic key fallback is not.

To keep keys out of the file entirely, name an environment variable instead —
`apiKeyEnv: OPENCODE_KEY_1` reads the key from the environment, and a profile may
carry both, with the literal `apiKey` winning. Either way `keys` reports only
`configured`/`missing`, never the value.

The plugin also accepts a `providers` object directly in `pi.settings` when the
OMP host exposes structured plugin settings. `profilesFile` is the portable
configuration path.

### Add a URL/API provider through OpenCode

### OpenRouter (or any OpenAI-compatible URL + key)

OpenRouter is just an OpenAI-compatible URL, so it needs no plugin support —
only two things in two different files. The **URL goes in OpenCode's config**
(because OpenCode is what dials it); the **key goes in the bridge's profile
file** (because that is what the bridge swaps per account).

**1. Define the provider** in `~/.config/opencode/opencode.json`
(`%USERPROFILE%\.config\opencode\opencode.json` on Windows; it may not exist
yet — create it, and if you already have one, add to its `providers` object):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "openrouter": {
      "package": "@ai-sdk/openai-compatible",
      "name": "OpenRouter",
      "settings": {
        "baseURL": "https://openrouter.ai/api/v1"
      },
      "models": {
        "anthropic/claude-sonnet-4.5": { "name": "Claude Sonnet 4.5" },
        "openai/gpt-5.6-sol": { "name": "GPT-5.6 Sol" }
      }
    }
  }
}
```

Three details that are easy to get wrong, all verified against OpenCode 2.0.12:

- the key is **`providers`**, plural — there is no `provider` key (that spelling
  is silently ignored);
- the fields are **`package`** and **`settings`**, not `npm` / `options` — with
  `npm`/`options` OpenCode drops your `baseURL` and `apiKey` and leaves a
  provider that cannot authenticate;
- the `models` map is **required** — OpenCode only exposes what you list, so the
  bridge only discovers what you list. Copy the model IDs from
  [openrouter.ai/models](https://openrouter.ai/models); they use `vendor/model`.

**2. Add the key** to your credential file:

```yaml
providers:
  openrouter:
    credentials:
      - id: account1
        apiKey: sk-or-v1-...
      - id: account2
        apiKey: sk-or-v1-...
```

The `openrouter:` here is the **same name** as in `opencode.json` — that is how
the bridge matches the URL config to the key. A name in one file but not the
other will not work, and it looks like "no such model".

**3. Refresh and use:**

```
omp models refresh
omp models opencode-bridge
# opencode-bridge/openrouter/anthropic%2Fclaude-sonnet-4.5@account1
```

Each account gets its own isolated server and its own key, so `@account1` and
`@account2` are two different OpenRouter accounts. To mix providers, list them
side by side in both files — `providers:` in YAML can hold `opencode:` and
`openrouter:` together, and `providers` in JSON can hold both definitions.

Do not put the key in `opencode.json`. The bridge starts a server per account and
overwrites `settings.apiKey` with the selected profile's key, so a key in the
OpenCode config would be ignored. Use `apiKeyEnv` in the profile file if you
would rather keep the key out of YAML entirely.

### Any other OpenAI-compatible endpoint

The plugin does not store API keys or hardcode an endpoint. For any
OpenAI-compatible provider, follow the OpenRouter recipe above with your own
`baseURL` and `package`. For a provider OpenCode already knows, no config is
needed at all — the bridge discovers it from `opencode auth login`, and you
only add a profile file entry if you want multiple accounts for it.

without a profile — the key then comes from OpenCode's own auth:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "my-provider": {
      "package": "@ai-sdk/openai-compatible",
      "name": "My Provider",
      "settings": {
        "baseURL": "https://example.com/v1",
        "apiKey": "{env:MY_PROVIDER_API_KEY}"
      },
      "models": {
        "my-model": { "name": "My Model" }
      }
    }
  }
}
```

Set the key in the environment, reload OpenCode, then refresh OMP's model cache:

```powershell
$env:MY_PROVIDER_API_KEY = "sk-..."
opencode reload
omp models refresh
```

This form puts the key in the environment rather than a profile, so there is one
credential and no `@account` suffix. Add a profile file entry (see
[OpenRouter](#openrouter-or-any-openai-compatible-url--key) above) as soon as
you want a second account.

Use a project config at `opencode.json` for project-local settings, or the user's
OpenCode config for global settings. Do not commit API keys or `.env` files.

### The other way: a direct URL provider (no OpenCode at all)

Everything above routes through OpenCode. You do **not** have to. A `directProviders:`
entry in the same profile file makes the plugin dial the `baseURL` itself.

> **Direct URL providers do NOT belong in `~/.config/opencode/opencode.json`.**
> They are not OpenCode providers: no `opencode.json` entry, no `/api/provider`
> entry, no OpenCode discovery, no OpenCode session. OpenCode never learns the
> provider or its key exists. This is the whole point of the feature — so
> putting one in `opencode.json` is both unnecessary and wrong.

```yaml
directProviders:
  jev:
    name: JEV
    protocol: openai-chat          # or openai-responses
    baseURL: https://<your-jev-host>/v1
    models:
      - id: jev
        name: JEV
        capabilities: { streaming: true, tools: true, vision: false, reasoning: true }
        contextWindow: 200000
        maxOutputTokens: 32000
    credentials:
      - id: account1
        apiKeyEnv: JEV_API_KEY_1   # preferred: keeps the key out of the file
      - id: account2
        apiKeyEnv: JEV_API_KEY_2
```

```powershell
$env:JEV_API_KEY_1 = "..."
$env:JEV_API_KEY_2 = "..."
omp models refresh
omp --model direct/jev/jev@account1
```

Each `(model × credential)` pair becomes its own selectable OMP model:

```
direct/jev/jev@account1
direct/jev/jev@account2
```

The `@accountN` suffix **is** the routing: it picks the credential resolved for
that one request, and each request carries its own `Authorization: Bearer <key>`.
It is not a display alias. The namespace is `direct/`, so it cannot collide with
`opencode-bridge/`.

| Field | Meaning |
|---|---|
| `protocol` | `openai-chat` (POST `<baseURL>/chat/completions`) or `openai-responses` (POST `<baseURL>/responses`). Pick the one the endpoint actually speaks. |
| `baseURL` | Must be `http(s)`; trailing slashes are trimmed. |
| `models[].capabilities` | `streaming` / `tools` / `vision` / `reasoning`. A provider with `tools: false` refuses a tool turn instead of dropping the tools. |
| `models[].capabilities.efforts` | Optional effort levels for a `reasoning: true` model, e.g. `[low, high, xhigh]`. Omitted means reasoning with no selectable effort. Levels must come from OMP's own ladder (`minimal`, `low`, `medium`, `high`, `xhigh`, `max`); anything else is dropped, and the rest are ordered weakest-first. |
| `credentials[].apiKeyEnv` | Read **per request**, so exporting the key after OMP started still works. |
| `credentials[].apiKey` | Literal key, kept for backward compatibility. `apiKeyEnv` is preferred. |
| `discovery.enabled` | Optional `GET <baseURL>/models` to *add* model ids. Failure is ignored and never removes your manual list. |

### Reasoning and effort

Reasoning capability comes from the provider's metadata, never from the model
name — no `deepseek-r*` / `qwq` / `think` regex. Discovery reads two fields from
each `GET /models` record:

* `supported_parameters` containing `"reasoning"` → the model is a reasoning
  model. A record that advertises nothing is left non-reasoning rather than
  guessed, since a false positive shows a picker the API then rejects.
* `reasoning.supported_efforts` → exactly the levels OMP offers for that model.
  OMP shows only what the provider reported, and gaps are preserved (a model
  advertising `["xhigh","high"]` gets no `medium`).

A reasoning model that advertises no ladder is still a reasoning model and is
still selectable — it just has no effort knob, because the provider said so.

The level you pick is sent to the provider as `reasoning_effort`. A level the
model never advertised is dropped rather than forwarded or rewritten, so the
provider applies its own default instead of failing the request. With nothing
selected, no effort is sent at all.

Levels are ordered by OMP's canonical ladder rather than the provider's, matching
what OMP's own OpenRouter adapter does. So `"none"` — which OpenRouter does
report for some models — is not a selectable level, since OMP's ladder has no
such rung.

Keys are never logged, never placed in a model id, never returned in an error,
and never written to `process.env`. Config errors name the provider and
credential but never the value:

```
Direct provider "jev": credential "jev/account2": environment variable JEV_API_KEY_2 is not set
```

Because this path never touches OpenCode, a direct provider keeps working when
OpenCode is not installed, not running, or not authenticated.

## Diagnostics

```
omp-opencode-bridge doctor            # human-readable
omp-opencode-bridge doctor --json     # machine-readable
```

Reports (non-secret only): OpenCode detected, version, server reachability, providers discovered, model count, and the streaming/tool-calling/reasoning capability status.

## Using OpenCode models in OMP

Once installed and OpenCode has an authenticated provider, discovered models appear as:

```
opencode-bridge/<provider>/<model>
```

### Selecting a model

```
omp --model opencode-bridge/opencode/space-bunny-free
```

The `opencode-bridge/*` entries in OMP's model picker are populated by dynamic discovery.
OMP caches dynamic results for 24 hours, so after changing OpenCode configuration run:

```
omp models refresh
```

The provider ID and model ID come from `opencode api model.list`; do not add the
`opencode-bridge/` prefix to the OpenCode configuration.

### Reasoning content vs. reasoning effort

These are two different things and the bridge treats them differently:

- **Reasoning *content* is supported.** OpenCode emits `session.reasoning.started` / `.delta` / `.ended` on the event stream. The bridge maps them onto OMP's real `thinking_start` / `thinking_delta` / `thinking_end` events and a `{type: "thinking"}` content block, in upstream order relative to text. On the buffered fallback path the same block is emitted from the `reasoning` content part of the finished message.
- **Reasoning *effort* is not supported.** OpenCode selects effort as a *variant on the model reference* passed to `session.create` (`model.variant`), not as a per-request field, so a per-turn effort cannot be honored. OMP sets the model variant when the user picks a reasoning model; passing an effort to a request yields a clear capability error rather than a silently ignored flag.

## Auditing an external plugin before install

```
omp-opencode-bridge plugin-audit ./some-plugin
omp-opencode-bridge plugin-audit ./some-plugin/package.json --json
```

It normalizes the manifest to `{name, version, source, entrypoint, permissions, config}`, then:

- **Errors (block):** missing name/entrypoint, entrypoint path traversal outside the plugin root.
- **Warnings (advisory):** missing version, insecure (non-https) source URL, unknown permissions, and high-trust capabilities (`shell`, `credentials`, `filesystem`).

Exit code `0` = static checks passed, `1` = blocked. Installing is still your decision — this is advice, not a sandbox.

Recognized source kinds: `directory`, `package` (registry name), `github` (`owner/repo`), `git` (`git+https://…`), `url` (`https://…`).

## Security model (honest version)

- OMP runs extensions in-process with the same privileges as OMP itself. There is **no runtime isolation** the bridge can impose. The audit is a **pre-install** gate you run by hand.
- **Secrets are never printed.** All CLI/API error text and diagnostics pass through a redactor that masks authorization headers, api keys (`sk-…`), bearer tokens, cookies, passwords, and long opaque tokens.
- **OpenCode owns its own auth.** The bridge shells out to `opencode api`, which authenticates to its own local server. No API keys are copied into OMP, and OMP's `apiKey` is unused by this provider.
- **Direct providers carry their own key, per request.** A direct provider's credential is read at request time and used only to build that one request's `Authorization` header. It is never assigned to `process.env`, never placed in a model id, never sent to OpenCode or written to `opencode.json`, and never included in an error — an upstream that echoes the header back is redacted against the exact key that was sent.
- **Path & source safety** in the audit: paths are canonicalized and traversal is rejected; source URLs are sanity-checked.
- Child processes are killed (SIGKILL) on timeout or cancellation — no orphaned `opencode` processes.

## How discovery works

1. `opencode --version` → detect the executable and version.
2. `opencode api model.list` → map real per-model records to OMP model configs.
3. `provider.list` and the `opencode models` table are fallbacks when the preferred API is unavailable.
4. Empty results are reported honestly — the bridge never invents models.

## Troubleshooting

- **`doctor` says "detected: no"** — `opencode` isn't on `PATH`; set `OPENCODE_BIN` or `opencodePath`. On Windows the bridge looks for the real `opencode.exe` under the npm global prefix and spawns it directly, because routing the `opencode.cmd` shim through `cmd.exe` makes it reject JSON request bodies.
- **No models under `opencode-bridge`** — run `opencode auth login` for a provider, then `omp models refresh` (discovery results are cached for 24h). Check with `omp models opencode-bridge`. If `omp plugins` doesn't list the bridge at all, it was never installed correctly — see [Install](#install).
- **A direct provider vanishes from `omp models`** — it is missing from the model list when its `apiKeyEnv` variable is unset, because the profile file is validated at load. Export the key and re-run `omp models refresh`. `omp-opencode-bridge doctor` reports the same missing variables without printing their values.
- **`keys` says `placeholder`** — the entry still holds the template's `sk-replace-me`; open the profile file and paste the real key. (`missing` means the `apiKeyEnv` variable is unset.)
- **`setup` succeeds but `omp plugins` doesn't list the bridge** — the install landed in the wrong project. `setup` now creates `~/.omp/plugins/package.json` and verifies the files; run `omp-opencode-bridge setup .` again, or check for a stray `package.json` in a parent directory.
- **A profile request fails but the unprofiled one works** — the selected key is bad, expired, or not enabled for that provider. Try the same model without the `@profile` suffix.
- **Inference returns a capability error** — you passed `tools`, `temperature`, `maxTokens`, image input, or a reasoning effort. All are refused by design; see the capability boundary above.
- **Model list is stale** — OMP caches dynamic models for 24h; run `omp models refresh`.
- **"did not go idle" / hangs** — the session never finished. `waitTimeoutMs` (120s default) bounds it; the error is reported rather than hung.

## Known limitations

- Streaming depends on the server exposing `GET /api/event`; when it does not, the bridge falls back to a single buffered `text_delta`. `opencode doctor` reports which transport is live.
- The SSE connection is **not reconnected**. A drop mid-stream is reported as an error rather than replayed, because resuming a partial token stream would corrupt the answer. It is not retried automatically — start a new request.
- OpenCode's own tool calls (`session.tool.*`) are not forwarded as OMP tool-call events; OpenCode runs its agent tools internally and the bridge surfaces only reasoning and text.
- Caller-supplied tool schemas, `temperature`, `maxTokens`, and image inputs are unsupported, as is per-request reasoning **effort** (reasoning *content* is supported).
- Response extraction binds the shapes captured from a live OpenCode server (`oc_openapi.json`); a future schema change surfaces as a loud capability error, not a wrong answer.
- No runtime sandbox for third-party plugins (an OMP-core limitation, documented rather than faked).

## Development

```
npm test        # node --test, no network, no OpenCode required (uses stubs/mocks)
```

## License

MIT
