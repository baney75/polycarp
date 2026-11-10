---
title: Polycarp privacy policy
seo_title: "Polycarp privacy policy: what it reads and where it goes"
description: What the Polycarp extension and Mac app read, where that goes, what stays on your computer, and how to delete it. No accounts, no analytics.
updated: November 6, 2026
---

# Polycarp privacy policy

Polycarp is free software made by Donovan Baney. It has no accounts and no analytics, and it runs no servers of its own. We don't receive your data, so we can't sell it, share it or read it.

This policy covers the Polycarp browser extension and the Polycarp app for Mac. On Windows and Linux, Polycarp today is the extension and a command that works on local files, so the extension's section applies. What's below describes the software as it's built today. The source is public at [github.com/baney75/polycarp](https://github.com/baney75/polycarp), so you can check it.

## The browser extension

### What it reads

The extension can read and act on web pages, including pages you're signed in to, so that an AI agent can do work you ask for. It reads a page when you or an agent you connected asks it to. This can include the page's text, its address, form contents and screenshots. Agents work in their own tab group and can't see your other tabs.

### Where that goes

To the AI you choose, and to the sites the agent visits for you. When an agent opens a site, fills in a form or looks something up, that site receives what any browser would send it, under your sign-in if you have one there.

- **The side panel.** Your messages, and what the agent reads from pages, go to the AI provider you picked, using your own API key or your own sign-in. That provider's privacy policy then applies. Providers you can pick include Anthropic, OpenAI, Google, Mistral, xAI, Groq, Cerebras, Hugging Face, Z.ai, OpenRouter and GitHub Copilot. You can also use a model on your own computer or network, and then your prompts don't go to an AI company. **Free mode** goes through OpenRouter, and free models there may keep and train on what you send, including signed-in pages and screenshots. Polycarp asks before Free mode first turns on and says so while it's on. It tries free models that keep nothing first and removes keys, card numbers and Social Security numbers from text, but it can't promise more than that. Don't use Free mode with mail, banking, medical or work accounts.
- **Private mode.** When it's on, the side panel only sends prompts to a provider that doesn't keep them: OpenRouter with zero data retention, a model on your own computer or network, or a host you named as your own.
- **A coding agent you connect**, such as Claude Code or Codex. It reaches the extension through the Polycarp helper on your computer. What it reads goes to that agent and is then covered by that agent's own terms.
- **Remote access**, if you turn it on. It's off until you turn it on. It lets assistants you approve reach your browser through your own Tailscale or Cloudflare tunnel. Polycarp runs no service for this, but traffic passes through the tunnel you pick, so that company's terms apply too.

### Other things the extension contacts

These don't get your chats. Some carry a small piece of what the agent is working on, as the table says.

| What | Who it contacts | What they see |
| --- | --- | --- |
| The list of AI models and prices | models.dev, your AI providers, OpenRouter | An ordinary request, and your key only when asking that provider |
| Speech models for side panel dictation, if you use it | Hugging Face | A download request. Your voice stays on your computer |
| Packages the agent loads to run its own code, such as a chart or a spreadsheet library | The CDN it names: esm.run, jsDelivr, unpkg, cdnjs, esm.sh, Skypack or Tailwind | The name of the package. This code runs in an isolated sandbox with no access to your pages or your browser |
| Checking sources for the library | Crossref, OpenAlex, doi.org | The citation being checked |
| Community skills, and updates for copies not from the Chrome Web Store | GitHub | An ordinary request |

### What stays on your computer

- **Chats, skills, settings and API keys** stay in the extension's storage in your browser. Your keys go only to the provider they belong to.
- **Past chats for your coding agents.** A copy of your side panel chats, including what the agent read from pages, is kept in `~/.local/share/polycarp/browser/threads`, whichever AI you use and whether or not you've connected an agent, so your own coding agents can read it. Any program you run on your computer can read that folder, and what a coding agent reads from it goes to that agent's company. Keys are removed from the copy, and private mode chats are never copied. It's on by default. Turn it off in Settings > Privacy, which deletes the copies.
- **Error reports** are off by default. When you turn them on, errors are kept on your computer with secrets removed. Nothing is sent. You read the report, copy it, and paste it into a GitHub issue yourself if you choose to.

### Limited Use

The use of information received from Google APIs will adhere to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies), including the Limited Use requirements. Polycarp uses what it reads only to do the work you ask for. It passes that data on only to do that work: to the AI you picked, including a free model if you turned on Free mode after being told it may keep what you send; to a coding agent or assistant you connected; to the sites an agent visits for you; to the services above when a source is checked; and through a remote access tunnel if you turned one on. Polycarp doesn't use it for advertising, doesn't sell it, doesn't use it to decide credit or lending, and has no people who could read it.

## The Polycarp app for Mac

- **Silas, the voice part,** turns speech into text on your Mac. It listens only from when you press the key until you let go or tap again. The audio isn't saved or sent anywhere. Your dictionary and history stay on your Mac. It downloads speech models from Handy's server or Hugging Face, and a list of which model suits which Mac from GitHub. It can make a device report to share, but only you can send one, by reviewing and submitting a GitHub issue yourself.
- **Workspaces** reads window titles and positions to arrange your windows. These stay on your Mac.
- **The launcher** looks up apps when you ask. It sends what you typed to Apple's App Store search, and it downloads Homebrew's public list of apps.
- **Updates.** The app asks GitHub about new releases.

## Deleting your data

- **Extension:** first turn off the chat copies in Settings > Privacy, or delete `~/.local/share/polycarp/browser/threads` yourself, since removing the extension can't reach that folder. Then remove the extension from your browser, which deletes everything it stored there. To delete only your chats, keys or settings, use its Settings. A chat you delete there can stay in the chat copy until you turn the copy off.
- **Mac app:** run the uninstaller, then delete the `Polycarp` folder in `~/Library/Application Support`.
- **Data you sent to an AI provider:** ask that provider. We never had it.

## Children

Polycarp isn't meant for children under 13, and we don't knowingly collect anything from anyone.

## Changes

If this policy changes, the new version goes here with a new date, and the history stays public in the source repository.

## Questions

Email [donovan@dbaney.com](mailto:donovan@dbaney.com).
