# Chrome Web Store listing

Everything the developer dashboard asks for, ready to paste. Build the zip with `scripts/build-store.sh <out dir>`. Reasons for each permission are in [permissions.md](permissions.md).

## Store listing tab

**Title:** Polycarp

**Summary:** Lets AI agents work in your browser, in their own tab group, while you keep working.

**Category:** Tools (Productivity)

**Language:** English

**Description:**

```
Polycarp lets an AI agent work in your browser while you keep working. The agent gets its own tab group. It opens pages, reads them, clicks, fills in forms and checks its own work there, and your tabs stay yours.

Use it two ways:

• Chat in the side panel. Bring your own API key from Anthropic, OpenAI, Google, OpenRouter and others, or run a model on your own computer. Free mode uses a free OpenRouter key.
• Connect the coding agent you already use. Claude Code, Codex and any MCP agent can drive your browser through the free Polycarp helper on your computer.

You stay in charge:

• The agent can't open a new site until you allow it.
• It stops and hands the tab to you for sign-ins and captchas.
• Private mode only sends prompts to places that don't keep them.
• It can check that a citation is real and not retracted before citing it.

Polycarp has no account and no analytics, and it runs no servers of its own. Your chat history and keys are kept on your computer. Your messages, and what the agent reads, go to the AI you picked. Free models may keep and train on what you send, so Polycarp asks first, tries ones that keep nothing and removes keys and card numbers from text.

Free software under the AGPL-3.0. Source: https://github.com/baney75/polycarp
Built on 0xSero's agent bridge and Mario Zechner's Sitegeist.
```

**Homepage:** https://dbaney.com/polycarp/

**Support:** https://github.com/baney75/polycarp/issues

**Images:**

- Icon: `static/icon-128.png`
- Screenshots, 1280x800: `store/screenshots/`
- Small promo tile, 440x280: `store/promo-small.png`
- Marquee, 1400x560: `store/promo-marquee.png`

## Privacy tab

**Single purpose:**

```
Polycarp lets AI agents operate web pages in the user's browser on the user's behalf, from its side panel or from an AI agent the user connects.
```

**Are you using remote code?** Yes.

```
The agent's page actions run through the Debugger API and the User Scripts API, the two APIs the program policies permit for this, and only as those APIs document. Separately, the agent can write code that runs in sandbox.html, a sandboxed page isolated from extension APIs. That code can import packages from public CDNs (esm.run, jsDelivr, unpkg, cdnjs, esm.sh, Skypack, Tailwind), listed in the manifest's sandbox content security policy, for example to draw a chart or read a spreadsheet the user attached. All of the extension's own logic is in the package; nothing fetched remotely runs with extension API access.
```

**Data usage: what the extension handles.** Tick these:

- Authentication information: API keys and provider sign-ins the user adds. Stored locally and sent only to that provider.
- Web history: the addresses of pages the agent opens.
- User activity: the agent's clicks and typing in its own tabs.
- Website content: text, images and form contents of pages the agent reads.

Leave the other boxes empty.

**Certify all three:** not sold to third parties, not used or transferred for purposes unrelated to the single purpose, not used to determine creditworthiness or for lending.

**Privacy policy:** https://dbaney.com/polycarp/privacy/

## Distribution tab

**Visibility:** Public. **Regions:** All.

## Test instructions for the reviewer

```
No account is needed.

1. Click the toolbar icon to open the side panel.
2. Click "Set up provider" and add an API key for any listed provider. A free key from openrouter.ai works with Free mode.
3. Ask: "Open example.com and tell me what the page says."
4. Approve example.com when asked. A new tab group opens, and the agent reads the page in it.

Connecting a coding agent needs the free Polycarp helper from https://dbaney.com/polycarp/. It isn't required to review the side panel.
```
