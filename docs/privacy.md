---
title: Polycarp privacy policy
seo_title: "Polycarp privacy policy: what it reads and where it goes"
description: What the Polycarp Mac app and commands read, where that goes, what stays on your computer, and how to delete it. No accounts, no analytics.
updated: November 24, 2026
---

# Polycarp privacy policy

Polycarp is free software made by Donovan Baney. It has no accounts and no analytics, and it runs no servers of its own. We don't receive your data, so we can't sell it, share it or read it.

This policy covers the Polycarp app for Mac. Polycarp's browser extension, for reading, a library and calmer feeds, has its own policy: [spaces/extension/PRIVACY.md](https://github.com/baney75/polycarp/blob/main/spaces/extension/PRIVACY.md). The browser-driving extension that older Polycarp builds shipped was removed, and nothing here drives a browser. If you still run a copy of it, [the policy as it stood](https://github.com/baney75/polycarp/blob/b8e8984f/docs/privacy.md#the-old-browser-driving-extension) covers it. On Windows, Polycarp today is a command that works on local files; its file search works across your devices and is covered below. What's below describes the software as it's built today. The source is public at [github.com/baney75/polycarp](https://github.com/baney75/polycarp), so you can check it.

## The Polycarp app for Mac

- **Workspaces** reads window titles and positions to arrange your windows. These stay on your Mac, unless an agent you connect asks for them (below).
- **The launcher** sends what you type in its Install menu to Apple's App Store search, and it downloads Homebrew's public list of apps.
- **Web search**, from the launcher, the new tab page, `polycarp-spaces search` or an agent. Your words are matched against your open tabs, windows and terminal splits on your Mac, and Polycarp sends nothing to look them up. Opening a web result opens it in your browser, so the words go to your search engine (Google unless you chose another), to the site or AI service a bang such as `!yt` or `!claude` names, or to DuckDuckGo for a bang Polycarp doesn't know.
- **A wallpaper from a web address.** When you or an agent sets the wallpaper to an https URL, the app downloads that picture from its host and any host it redirects to. They see an ordinary request.
- **Files.** `polycarp files` keeps an index of file names and the text inside files on each of your devices. Searches, results and the files you copy go between them over your own Tailscale network only, unless an agent you connect asks for them (below) ([what it never reads](files.md#what-it-never-reads)).
- **Agents you connect**, such as Claude Code or Codex, over `polycarp mcp`, `polycarp files mcp` or `polycarp agent`. What a tool returns goes to that agent and is then covered by its own terms. `search` returns the titles of open tabs, windows and terminal splits, with a folder or host for some. The file tools return file names and contents, from your other devices too. Web assistants reach your Mac only through a tunnel you set up, so traffic passes through that company and its terms apply too, and you approve each assistant on your Mac ([agents](agents.md)).
- **Updates.** The app asks GitHub about new releases.
- **Files from the retired purpose features.** Polycarp no longer asks what a workspace is for or keeps a day log or journal, and it no longer reads or writes `purposes.json`, `ledger.json` or `Journal/` in `~/Library/Application Support/Polycarp`. Files an older version wrote stay where they are, untouched, until you delete them. They were never sent anywhere.
- **Contacts**, only after you allow it: the launcher reads names, nicknames, companies, numbers, email addresses and contact pictures to call and message people. They stay on your Mac. A small file there lists who you reached from Polycarp and when, with no numbers and no message text ([contacts](contacts.md)).

## Deleting your data

- **Extension:** remove it from your browser, which deletes everything it stored there. If you ever used the agent extension older builds shipped, also delete `~/.local/share/polycarp/browser`, where it kept copies of chats; removing an extension can't reach that folder.
- **File index**, on each device that has one, before you uninstall the app: run `polycarp files service uninstall` and the stop command it prints, then delete `~/Library/Caches/Polycarp/files` on a Mac, `%LOCALAPPDATA%\Polycarp\files` on Windows or `~/.cache/polycarp/files` on Linux.
- **Mac app:** run the uninstaller, then delete the `Polycarp` folder in `~/Library/Application Support`.
- **Data you or your agents sent to an AI provider:** ask that provider. We never had it.

## Children

Polycarp isn't meant for children under 13, and we don't knowingly collect anything from anyone.

## Changes

If this policy changes, the new version goes here with a new date, and the history stays public in the source repository.

## Questions

Email [donovan@dbaney.com](mailto:donovan@dbaney.com).
