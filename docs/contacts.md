# Contacts: call, FaceTime and message people

Polycarp's launcher finds the people in macOS Contacts. Type a name and the person shows with what you can do:
Call, FaceTime, Message and Email. Agents can do the same through `polycarp-spaces contacts`.

Polycarp never sends a message. The message action opens Messages with your draft in the box, and you press Send.

## In the launcher

| You type | What shows | Return | Command-Return |
| --- | --- | --- | --- |
| `anna` | Anna, below apps | Call (Email for someone with no number) | the next action, FaceTime |
| `call anna` | Anna, at the top | Call | FaceTime |
| `facetime anna` | Anna, at the top | FaceTime | Call |
| `message anna running late` | Anna, with "running late" | Messages opens with "running late" typed in; you press Send | Call |
| `email anna see you at 6` | Anna, with the body | Mail opens a new message with the body | Call |
| `call ` | the people you reached lately | Call | FaceTime |

`text`, `msg` and `sms` work like `message`; `mail` works like `email`; `phone` works like `call`. A plain name needs
two letters. The footer says what Command-Return does for the row you're on.

A verb never takes an app's launch. When an app's name holds what you typed, spaces aside (`text edit` is TextEdit,
`phone mirroring` is iPhone Mirroring), the words are read as a plain name and wait below the apps. After a verb, a
person goes above the apps only when every typed word starts a word of their name, nickname or company; initials show
below the apps, and letters found inside a name (`edit` in Meredith) don't show at all.

- **Call** opens `tel:` with the number, which goes to the Phone app (or a FaceTime audio call through your iPhone).
  Someone with only an email address gets a FaceTime audio call.
- **FaceTime** opens `facetime:` with the number or address.
- **Message** opens Messages to that person (`sms://open?addresses=…&body=…`). Spaces, plus signs, accents and emoji
  in the draft reach Messages as you typed them.
- **Email** opens `mailto:` with the body, if you typed one.

**Which number or address:** the one you used last for that person from Polycarp, else a mobile (or iPhone) number,
else the first one. A call goes to a phone number when the person has one.

**Extensions and letters:** a number stops at an extension or a pause (`x`, `ext`, `extension`, `#`, `*`, `,` or
`;`), so `555-010-2000 ext. 123` dials 5550102000 and you enter the extension yourself. Letters in a vanity number
are spelled on the keypad: `1-800-FLOWERS` dials 18003569377.

**Order:** a name that is the whole name or starts it comes first, then a word of the name, nickname or company
(`an sm` finds Anna Smith, `acme` finds people at Acme), then initials, then letters inside a name. Among the good
matches, the people you reached lately from Polycarp come first.

## Contacts access

Polycarp asks for Contacts access only when you first use a contact feature: type `call`, `message`, `facetime` or
`email` and a name, or `contacts`, and the launcher shows one row, "Allow Contacts to call and message people", with
the reason: Polycarp reads your contacts on this Mac so you can call, FaceTime, message and email people from the
launcher, and it never sends a message for you. Return shows macOS's own box. A plain search never asks.

If access is off, the same words show one row, "Contacts access is off", whose button opens System Settings at
Privacy & Security > Contacts. Turn on Polycarp there; the launcher notices the next time it opens. Settings >
Permissions lists Contacts under Optional with the same button.

If reading Contacts fails, Polycarp tries again after 1, 5 and 30 seconds, then stops. A contact search then shows one
row, "Couldn't read Contacts", and the command says the same; the next time the launcher opens it starts over.

Your contacts stay on this Mac. Polycarp reads names, nicknames, companies, numbers, email addresses and the small
contact pictures on its own queue, keeps them in memory, and reads them again when Contacts changes. It never changes a
contact.

## Recents

`~/Library/Application Support/Polycarp/contacts-recents.json` holds the last 200 times you called, FaceTimed,
messaged or emailed someone from Polycarp: the person's Contacts identifier, the action, a fingerprint of the number
or address (not the number itself) and the time. It never holds message text. It ranks people and picks the number
used last. Delete the file to start over.

## For agents

```sh
polycarp-spaces contacts find anna            # names and the kinds of handles: phone (mobile), email (work)
polycarp-spaces contacts find anna --json     # the same as JSON
polycarp-spaces contacts find anna --full     # with the numbers and addresses
polycarp-spaces contacts call "anna smith"
polycarp-spaces contacts facetime "anna smith"
polycarp-spaces contacts message "anna smith" --text "running late"
polycarp-spaces contacts email "anna smith" --text "see you at 6"
```

The command asks the running app, which uses the same index, the same choice of number and the same links as the
launcher. Each action:

- acts on one person only. When more than one person matches as well (two Annas), it refuses and names them; say more
  of the name.
- opens the app on the owner's screen: the Phone app, FaceTime, Messages with the draft, or Mail. Polycarp never sends
  the message or the email: the owner reads the draft and presses Send.
- says which kind of handle it used (`phone (mobile)`), and the number only with `--full`.
- works on this Mac only. Another machine (`--on HOST`) can't read or reach people.

A command never asks macOS for Contacts access, since it isn't the owner using the launcher. Without access it exits 1
and says how the owner turns it on.

Call, FaceTime and Message put something in front of the owner. Use them only when the owner asked for that call or
that message.
