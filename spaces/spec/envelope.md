# The envelope

Every `baneyspaces` command and every MCP tool result is one JSON object.

```json
{ "ok": true,  "data": { } }
{ "ok": false, "error": { "code": "not_in_scope", "message": "...", "retry": "never", "suggestion": "..." } }
```

- `ok` is a boolean. `data` is present when `ok` is true; `error` when it is false. Never both.
- `error.data` (optional): extra facts about the failure, never content.
- `error.code`: one of the codes below. `error.message`: for a person. `error.suggestion`: what to
  do next, always present (may be empty only for `internal`).
- `error.retry`:
  - `safe`: nothing was delivered; the same call can be sent again.
  - `after`: nothing was delivered, but not yet: wait, then send it again (the daemon is re-reading
    the compositor).
  - `never`: refused, or the action may already have landed. Do not repeat it.
- Exit status of the CLI: 0 for `ok`, 1 for an error, 2 for `invalid_args`.

## Codes

| Code | Meaning |
| --- | --- |
| `invalid_args` | A bad argument (workspace 10). |
| `not_found` | No such window or monitor. |
| `ambiguous` | More than one match. `error.message` lists the candidates. |
| `not_in_scope` | The window is not on the agent workspace. |
| `in_use` | What the command would change is on screen or in use right now ([agent-api.md](agent-api.md)). |
| `not_supported` | Not on this platform, or removed. |
| `unverified` | The command was sent and its change was not seen ([agent-api.md](agent-api.md)). `retry` is `never`. |
| `daemon_down` | `baneyspaces daemon` is not running. |
| `single_instance` | The app forwarded to a running instance; it can't run as an agent process. `error.data.windows_that_appeared` lists windows that opened meanwhile (left where they are). |
| `needs_sandbox` | The app is not on the list of apps with a verified separate-process launch, so an agent may not start it (it could hand the request to your copy, or take over your launches). Refused before launch. |
| `bad_arguments` | `agent open` takes the name of an allowlisted app and files inside the handoff folder, nothing else: no flags, no paths to programs, no URLs. |
| `timeout` | Waited and nothing arrived. From a client: the request was sent and no answer came, so it may have been carried out (`retry` never). A failure to connect is `daemon_down` instead. |
| `agent_window` | A move of an agent window to your workspaces. |
| `no_monitor` | No monitor is connected. |
| `compositor_error` | The compositor refused a command or did not answer. `retry` is `safe` only for a clean refusal before anything moved, otherwise `never`; `error.data` says which. The daemon re-reads the compositor before the next command. |
| `internal` | A bug. |
