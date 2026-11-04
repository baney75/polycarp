---
name: proton-pass
description: Give a program a password, API key or token from the user's password manager without the secret ever entering your context, using Proton Pass CLI (`pass-cli run` with `pass://` references), 1Password (`op run` with `op://`) or Bitwarden Secrets Manager (`bws run`). Use when a command, script, test or deploy needs a credential, when the user says "it's in Proton Pass" or "use my 1Password", or before you would ask the user to paste a key.
license: AGPL-3.0
---

# Credentials through a password manager, never through you

You must never see a secret. A secret that enters your context can end up in a log, a
transcript, a summary or a reply, and a web page can trick you into sending it. So the
password manager puts the secret straight into the program that needs it, and you only
handle a reference such as `pass://Work/GitHub/token`.

## When to use

- A command needs an API key, token or password to run.
- The user says the credential is in Proton Pass, 1Password or Bitwarden.
- You were about to ask the user to paste a key into the chat. Ask for the item name
  instead, and use this skill.

Not for web sign-in forms. If a page needs a sign-in, hand the tab to the user with the
tabkyra `tabs_show` tool and let them sign in.

## The rules

- Never run a command whose purpose is to display a stored value. These are off limits:
  - `op read`
  - `op item get --reveal`
  - `bws secret get`
  - any `pass-cli` item view that includes hidden fields
- Never turn off output masking, and never redirect a resolved secret into a file.
- Never put a secret value in a command line, an argument, a commit or a chat message.
- You may list or search items by name to find the right reference. Item names are not
  secrets.
- If masked output still shows something that looks like a key, stop and tell the user.

## Steps

1. **Find which manager is installed.** Run `command -v pass-cli op bws`. Use the one the
   user named; otherwise Proton Pass, then 1Password, then Bitwarden.
2. **Check that it's signed in.** Proton Pass: `pass-cli info`. 1Password: `op whoami`.
   If it isn't signed in, stop and ask the user to sign in in their own terminal. Never
   handle their master password.
3. **Get the reference.** Ask the user for the vault and item name if you don't know
   them. Build the reference:
   - Proton Pass: `pass://<vault>/<item>/<field>`, for example `pass://Work/GitHub/token`
   - 1Password: `op://<vault>/<item>/<field>`, for example `op://Work/GitHub/credential`
   - Bitwarden Secrets Manager: no per-secret reference. `bws run` passes every secret in
     the access token's project, so use an access token whose project holds only the
     secrets this command needs.
4. **Write an env file of references, not values.** For example `refs.env` with the line
   `SERVICE_CREDENTIAL=pass://Work/GitHub/token`, using the env var name the program
   reads. This file holds no secrets. Add it to `.gitignore` anyway.
5. **Run the program through the manager:**
   - Proton Pass: `pass-cli run --env-file refs.env -- npm run deploy`
   - 1Password: `op run --env-file refs.env -- npm run deploy`
   - Bitwarden: `bws run -- npm run deploy`

   The manager resolves each reference and passes the value to that one process only.
   Proton Pass and 1Password mask the value if the program echoes it.
6. **Check the result by its effect,** for example the deploy succeeded or the API
   answered. Never confirm a credential by displaying it.

## Done when

- The command that needed the credential ran and did its job.
- No secret value appeared in your context, in a file, or in any command line.
- The env file holds only `pass://`, `op://` or ID references.

## When something goes wrong

| Symptom | Fix |
| --- | --- |
| `pass-cli: command not found` | Ask the user to install Proton Pass CLI from Proton's site. Don't install it yourself. |
| Not signed in | The user signs in in their own terminal. Wait for them. |
| Reference not found | List items by name (`pass-cli item list`, `op item list`) and fix the vault, item or field name. |
| Program says the key is invalid | Tell the user the stored value may be stale. Don't display it to check. |
| The task seems to need the raw value | It doesn't. Find the program's env var or config-from-env option. If there is none, stop and ask the user. |

## Worked example

The user says: "Run the release script; the token is in Proton Pass under Work/GitHub."
The script reads its credential from the env var the user's README names, here
`RELEASE_AUTH`.

```
command -v pass-cli                                   -> /usr/local/bin/pass-cli
pass-cli info                                         -> signed in
printf 'RELEASE_AUTH=pass://Work/GitHub/token\n' > refs.env
pass-cli run --env-file refs.env -- ./scripts/release.sh
                                                      -> Release v1.2.0 created
```

Reply: "The release script ran with your Work/GitHub token from Proton Pass. v1.2.0 is
created." You never saw the token.
