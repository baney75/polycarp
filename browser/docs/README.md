# Tabkyra docs

Start with the [README](../README.md) for setup and the safety model. Some documents below
came from Sitegeist, the extension Tabkyra is built on. They still describe the side
panel's internals correctly, but they call the product Sitegeist.

## Using Tabkyra

- [../cli/README.md](../cli/README.md): every `tabkyra` command, harness setup and site permissions.
- [updates.md](updates.md): how `tabkyra update` verifies signed releases, rollback, and the one-time signing key setup.
- [auth-policy.md](auth-policy.md): why the side panel takes API keys only, with each provider's terms and the date they were checked.

## Security

- [../SECURITY.md](../SECURITY.md): how to report a vulnerability privately, and what's in scope.
- [skill-security.md](skill-security.md): the threat model for skills, every lint rule, local edits, and the known gaps.

## How it's built

- [agent-bridge-design.md](agent-bridge-design.md): the design of the native messaging bridge, tab groups and background input that external agents use.
- [benchmarks.md](benchmarks.md): bridge benchmarks from four real tasks with independently fetched ground truth (2026-09-16).
- [fork-changes.md](fork-changes.md): what 0xSero's fork added on top of badlogic's Sitegeist, kept for credit and reference.
- [decisions.md](decisions.md): design defaults and the owner's answers, numbered D1 onward.

## Side panel internals (from Sitegeist)

- [prompts.md](prompts.md): how the system prompt, tool descriptions and provider descriptions are put together.
- [tool-renderers.md](tool-renderers.md): how tool calls and results are drawn in the chat.
- [custom-ui-messages.md](custom-ui-messages.md): custom message types and how each is shown to the model.
- [skills.md](skills.md): site skills, the JavaScript libraries the side panel agent injects on matching sites. These are not the agent skills in `skills/`.
- [storage.md](storage.md): the IndexedDB stores for sessions, skills and costs.
- [settings.md](settings.md): the key-value settings store.
- [multi-window.md](multi-window.md): window-scoped session locking. The side panel is now bound to a tab, so parts of this are historical (see CHANGELOG).
- [proxy.md](proxy.md): the CORS proxy design. The OAuth notes describe upstream; Tabkyra refuses those tokens.
- [i18n.md](i18n.md): how user-facing strings are translated with mini-lit.

## Project status

- [verification/STATUS.md](verification/STATUS.md): every Done Criteria item, labeled none, prepared, verified, deployed or published, with the evidence or the gap.
- [verification/dc-1.md](verification/dc-1.md): the record for the setup-prompt copy button check.
- [verification/dc-2-dc-9.md](verification/dc-2-dc-9.md): the records for scoped tokens, loopback HTTP and the tunnel commands, and the checks not yet run.

## Contributing

- [../CONTRIBUTING.md](../CONTRIBUTING.md): setup, checks, pull requests and skill contributions.
- [../AGENTS.md](../AGENTS.md): the rules coding agents follow in this repository.
- [../media/brand/BRAND.md](../media/brand/BRAND.md): the mark, palette, type and voice.
- [../CHANGELOG.md](../CHANGELOG.md): what changed, newest first.
