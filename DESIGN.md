# omp-opencode-bridge — Architecture & Design

An OMP (Oh My Pi) plugin that (1) documents/validates the loading of external
plugins and (2) bridges **OpenCode** as an OMP model provider.

All findings below were verified against the installed binaries and the real
OMP source packages (`@oh-my-pi/pi-ai`, `@oh-my-pi/pi-catalog`,
`@oh-my-pi/pi-coding-agent` 18.2.10 pulled from npm). No APIs are invented.

## Verified facts

### OMP (v18.2.6)
- Plugins are **npm packages** with an `omp` (or `pi`) field in `package.json`:
  `PluginManifest = { name?, version, tools?, hooks?, extensions?: string[], commands?: string[], features?, settings? }`.
- `omp plugin install|link|list|remove|update|doctor|discover|marketplace` already
  resolve **local dir / git / GitHub / URL / npm** sources, run `npm install` in
  the plugins dir, and validate manifests. (`omp plugin --help`.)
- Extension contract (`extensibility/extensions/loader.ts`): a module is either a
  factory function or `{ default: factory }`, `factory(pi: ExtensionAPI)`. Factory
  errors are rolled back per-extension — a broken plugin does **not** crash OMP.
- `pi.registerProvider(name, config: ProviderConfig)` (`extensions/types.ts`) supports:
  `baseUrl`, `apiKey` (literal or env-var name), `api`, `streamSimple`, `headers`,
  `authHeader`, `models[]`, `oauth`, and **`fetchDynamicModels(apiKey) => ProviderModelConfig[]`**
  — cached through OMP's SQLite model cache (24 h TTL). Exactly the dynamic-discovery hook we need.
- `ProviderModelConfig`: `{ id, name, reasoning, thinking?: {mode, efforts[]}, input:("text"|"image")[], cost, contextWindow, maxTokens, … }`.
- Model ids surface as `provider/id`, so registering provider `opencode` with model id
  `openai/gpt-5` yields `opencode/openai/gpt-5` in `omp models`.
- Settings schema supports `secret: true` (masked in UI/logs) and `env` fallback.

### OpenCode (v2.0.12, `@opencode/cli`, repo anomalyco/opencode)
- Background server; `opencode service status` → `http://127.0.0.1:<port>`.
- **`opencode api <operationId>` returns JSON** and handles server auth itself.
  Verified: `opencode api provider.list` → `{"location":{...},"data":[]}`,
  `opencode api config.get` → config sources.
- The local daemon also guards its HTTP surface with Basic auth. The bridge does not
  reimplement or store that scheme: it asks the CLI for the password
  (`opencode service get password`) only when it opens the event stream, and the
  value is never logged (`servicePassword()` in `opencode.js`).
- Model/provider discovery: `provider.list` (`data[]`), plus `opencode models`.
- Inference surface is **session-based agent** operations: `session.create`,
  `session.prompt`, streamed via `event.subscribe` / `/event`. There is **no
  OpenAI-compatible chat/completions endpoint**.

### The event stream (`GET /api/event`)

`event.subscribe` is the only endpoint that carries incremental output. Frames are
`data: {"id":…,"type":…,"data":{…}}` separated by blank lines, with `: heartbeat`
comments. The OpenAPI declares a frame as `{id, event, data}`; the server actually
sends the encoded event object as the `data:` payload, with the discriminator in
its own `type` field. Relevant event types, all carrying `data.sessionID`:

| event | payload | bridge action |
|---|---|---|
| `session.step.started` | `assistantMessageID` | start following this message |
| `session.reasoning.started` | — | new thinking block → `thinking_start` |
| `session.reasoning.delta` | `delta` | `thinking_delta` |
| `session.reasoning.ended` | `text` (full) | `thinking_end` |
| `session.text.started` | — | new text block → `text_start` |
| `session.text.delta` | `delta` | `text_delta` |
| `session.text.ended` | `text` (full) | `text_end` |
| `session.step.ended` | `finish`, `tokens`, `cost` | usage + finish reason |
| `session.usage.updated` | `tokens`, `cost` | usage refresh |
| `session.execution.succeeded` | — | emit `done` |
| `session.execution.failed` / `.interrupted` | `error` | emit `error` |

`/api/event` is one global stream: every session in the server appears on it, so
the bridge filters strictly by `data.sessionID`. It is also unbounded — which is
why `opencode api event.subscribe` cannot be used (the CLI child blocks forever,
leaking a process and buffering stdout). `fetch` with an abortable reader is the
transport; `close()` aborts the request in all exit paths.

## Selected approach

Register a single OMP provider, `opencode`, from an extension:

```
OMP Core → Provider Interface → [opencode provider adapter] → opencode CLI/server → providers → models
```

- **Discovery (fully supported):** `fetchDynamicModels` shells `opencode api provider.list`
  (documented JSON, not the TUI) and maps each provider/model to `ProviderModelConfig`
  with id `opencode/<provider>/<model>`. Fallback: parse `opencode models`.
- **Inference (bounded):** `streamSimple` drives the OpenCode **session API**. Because
  OpenCode is an agent, not a raw model gateway, tool-calling/streaming semantics differ
  from a native provider; the adapter maps what the session API exposes and raises a
  **CapabilityError** (never a silent wrong result) when a requested option or the
  server's response shape isn't supported.

### Two transports, one event sequence

```
streamSimple
├── SSE transport      session.create → open GET /api/event → session.prompt
│                      → filter by sessionID → emit deltas → session.execution.* → session.remove
└── buffered fallback  session.create → session.prompt → session.wait
                       → message.list → emit one delta → session.remove
```

Both emit the identical OMP event sequence (`start`, `thinking_*`, `text_*`, `done`)
from the same `partial` object, so a fallback is invisible to OMP apart from the
loss of incrementality. The SSE listener is opened **before** `session.prompt` and
awaited until response headers land, which is what makes the first-delta race safe.
Fallback happens only when the stream produced nothing at all; once a delta is out,
an error is an error — replaying a partial token stream would corrupt the answer.

### Alternatives considered
1. **OpenAI-compatible passthrough** (`api: "openai-completions"` + baseUrl) — rejected:
   OpenCode exposes no such endpoint (verified: only session ops).
2. **Replay OpenCode's provider API keys into OMP native providers** — rejected as default:
   duplicates secrets, and OMP already has those providers natively; offered only as an
   explicit, documented opt-in (`opencode.reuseAuth`) for providers OMP lacks.
3. **Scrape the TUI** — forbidden by spec; not done.

### Compatibility risks
- OpenCode `session.prompt` request/response JSON schema is not part of a frozen public
  contract; the adapter binds it defensively and fails loud on mismatch. Pinned/verified
  operation ids: `provider.list`, `config.get`, `session.create`, `session.prompt`, `event.subscribe`.
- No OMP core changes. Everything lives behind the provider adapter + one extension entry.

### Security boundary (stated honestly)
- OMP loads extensions as **trusted npm code with full host access — there is no sandbox.**
  This plugin does **not** invent one. What it provides for *external* plugins is
  **pre-install static validation + a capability advisory** (`plugin-audit`): manifest schema
  check, path canonicalization/traversal rejection, source-URL validation, and a printed
  capability report so a human makes an informed trust decision before `omp plugin install`.
- Secrets (API keys, `authorization`/`x-api-key` headers, tokens, cookies) are redacted in
  all diagnostics and logs. No plaintext secret is persisted by this plugin.
