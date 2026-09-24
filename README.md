# omp-opencode-bridge

An [OMP](https://oh-my-pi.dev) (Oh My Pi) plugin with two capabilities:

1. **OpenCode model bridge** — detect a real [OpenCode](https://github.com/anomalyco/opencode) install, discover its providers/models dynamically (never hardcoded), and expose them in OMP as `opencode-bridge/<provider>/<model>`.
2. **External-plugin audit** — a pre-install static validator for third-party OMP plugins: normalize the manifest, validate it, block path traversal, and surface declared capabilities before you install.

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

## Requirements

- Node.js ≥ 20
- OMP (to use the provider) — the audit CLI works standalone.
- OpenCode on `PATH` (or set `OPENCODE_BIN`) with at least one authenticated provider, for live model discovery/inference.
- OpenCode 2.x for plugin-managed credential profiles (verified with 2.0.12).

## Install

As an OMP plugin:

```
omp plugin install omp-opencode-bridge
```

Or from this directory during development:

```
omp plugin install .
```

Standalone CLI (audit + doctor without OMP):

```
npm install -g omp-opencode-bridge
omp-opencode-bridge doctor
```

### First run

Installing is all the setup there is. On first start the bridge creates
`opencode-bridge.profiles.yml` next to the installed plugin (or in `~/.omp`) with
your keys to fill in — nothing else to configure, no environment variables:

```
providers:
  opencode:
    credentials:
      - id: account1
        apiKey: sk-replace-me
```

Add one entry per API key, then restart OMP and run `omp models refresh`. Every
discovered model is then offered once per profile, e.g.
`opencode-bridge/opencode/space-bunny-free@account1`.

Check what it found without exposing any key:

```
omp-opencode-bridge keys      # → opencode/account1  configured
```

Keys may also be omitted from the file and taken from the environment with
`apiKeyEnv: OPENCODE_KEY_1` instead. The file is only ever written if it does not
already exist, and an unwritable install directory is not an error — the bridge
runs unprofiled.

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
| `profilesFile` | string  | unset   | `OPENCODE_BRIDGE_PROFILES_FILE` | YAML file containing provider-scoped credential profile IDs and environment variable names. |

### Multiple API keys for one OpenCode provider

Edit `opencode-bridge.profiles.yml`. It lives beside the **installed** plugin (or
in `~/.omp`), not in a source checkout, so updating or reinstalling keeps your
keys. Put the key straight in the file:

```yaml
providers:
  opencode:
    credentials:
      - id: account1
        apiKey: oc_sk_...
      - id: account2
        apiKey: oc_sk_...
```

Nothing else is needed: the plugin finds that file on its own. Set
`profilesFile` in the plugin settings (or `OPENCODE_BRIDGE_PROFILES_FILE`) only to
point somewhere else. Restart OMP, then run `omp models refresh`.
For example, a dynamically discovered `opencode/gpt-5.6-sol` becomes:

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

The plugin does not store API keys or hardcode an endpoint. For an OpenAI-compatible
provider, configure it in OpenCode's `opencode.json`, then let the bridge discover it:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "my-provider": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "My Provider",
      "options": {
        "baseURL": "https://example.com/v1",
        "apiKey": "{env:MY_PROVIDER_API_KEY}"
      },
      "models": {
        "my-model": {
          "name": "My Model"
        }
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

Use a project config at `opencode.json` for project-local settings, or the user's
OpenCode config for global settings. Do not commit API keys or `.env` files.

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
- **Path & source safety** in the audit: paths are canonicalized and traversal is rejected; source URLs are sanity-checked.
- Child processes are killed (SIGKILL) on timeout or cancellation — no orphaned `opencode` processes.

## How discovery works

1. `opencode --version` → detect the executable and version.
2. `opencode api model.list` → map real per-model records to OMP model configs.
3. `provider.list` and the `opencode models` table are fallbacks when the preferred API is unavailable.
4. Empty results are reported honestly — the bridge never invents models.

## Troubleshooting

- **`doctor` says "detected: no"** — `opencode` isn't on `PATH`; set `OPENCODE_BIN` or `opencodePath`. On Windows the bridge looks for the real `opencode.exe` under the npm global prefix and spawns it directly, because routing the `opencode.cmd` shim through `cmd.exe` makes it reject JSON request bodies.
- **No models under `opencode-bridge`** — run `opencode auth login` for a provider, then `omp models refresh` (discovery results are cached for 24h). Check with `omp models opencode-bridge`.
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
