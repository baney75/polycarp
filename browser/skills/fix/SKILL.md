---
name: fix
description: Repair a skill after a model used it and got a poor result - find why it failed, have a stronger model rewrite the skill for the model tier that failed, test the rewrite on that model until the result is good, then keep it personal or submit it. Use when the user types /fix, says a skill "didn't work", "gave a bad result", "my small model got this wrong", or after they recorded or chatted their way to a good result and want the skill updated.
license: AGPL-3.0
---

# /fix: make the skill work for the model that failed

A skill that works for a large model often fails a small one: too many choices, steps that
assume judgment, no example to copy. `/fix` rewrites the skill for the tier that failed,
using a stronger model as the author, and proves the rewrite on the weaker model.

## When to use

- `/fix <skill>`, or the user says a skill gave a bad result.
- The user recorded a correct run (the side panel's Record button) and wants the skill to
  match it.
- The user kept chatting until the result was good and wants the skill to learn from that.

For a small lesson from your own work, use `rsi` instead.

## Steps

1. **Check private mode.** If the user turned on private mode in Tabkyra, every model this
   skill uses (author and tester) must be one private mode allows. If none is stronger
   than the model that failed, stop and tell the user. Never send the reference run, the
   recording or the conversation to a cloud model in private mode.
2. **Pin the failure.** Write down: the skill, the model that failed and its tier (small:
   Haiku-class or a local 8B to 30B model; mid; frontier), the task, what it produced, and
   what a good result is. If you don't know what good looks like, ask the user one question.
3. **Pick the reference run.** Use, in this order of preference:
   - a recording the user made with Record (the exact clicks and pages);
   - the conversation where the user's corrections reached a good result;
   - a run you do yourself now, if you are the stronger model, on a test page or as an
     unsent draft: never a send, post, purchase, booking or deletion.
4. **Find the cause.** Compare the failed run with the reference, step by step. Name the
   first step where they part ways. Typical causes: a choice the model couldn't make, a step
   with two actions, a missing example, a tool call with the wrong parameter, too much text.
5. **Choose the author model.** It must be stronger than the model that failed. If you are
   the failing model, run the author through the harness: for example `claude -p --model
   opus` or `codex exec`. If no stronger model is available, stop and tell the user.
6. **Draft the fix** in `~/.config/tabkyra/skill-drafts/<name>/SKILL.md`, starting from
   `tabkyra skill print <name> --raw`. Write for the failing tier:
   - small: one action per step, exact calls with real parameters, a table instead of a
     judgment, one worked example copied from the reference run, nothing optional;
   - mid or frontier: fix the cause from step 4 and add the reference as an example.
   If the original works well for large models and the fix would weaken it, make a new
   skill `<name>-lite` for the small tier instead of editing the original.
7. **Keep it short.** The skill must stay under 150 lines. Cut words before adding
   sections.
8. **Lint and preview:** `tabkyra skill apply ~/.config/tabkyra/skill-drafts/<name>`
   (no `--yes`). It must exit 3 and show the diff.
9. **Prove it on the failing model.** Run the task again with the model that failed,
   loading the draft, but only in a way that changes nothing: a test page, a draft that
   isn't sent, a form that isn't submitted. Never repeat a send, post, purchase, booking or
   deletion to test a fix. Compare the result with "good" from step 2. If it falls
   short, go back to step 4 with the new run. After three failed tries, stop here: report
   which step still fails, and don't apply, keep or submit the draft. The rest of the
   steps are only for a draft that passed.
10. **Get the user's yes.** Show the diff and the passing result.
11. **Apply:** the same command with `--yes`.
12. **Keep or share.** Read `submit` in `~/.config/tabkyra/rsi.json`:
    - a skill holding personal data is never shared, whatever the setting;
    - `"never"`: keep it local;
    - `"ask"` (default): ask whether to propose it to the Tabkyra skill library;
    - `"auto"`: propose it.
    A proposal is a pull request to `baney75/tabkyra` that changes `skills/<name>/SKILL.md`.
    Its description names the failing tier and the cause, and describes the before and
    after results as patterns ("cited a paper that doesn't exist"), never as the user's
    content. Before opening it, scrub everything in it the way the `bug` skill's step 4
    does, and leave out page text, mail, names and IDs. CI and a maintainer review it
    before anyone else gets it.

## Done when

- The failing model produced a good result with the fixed skill, or three tries failed and
  the user knows which step still fails.
- The fix was applied with `tabkyra skill apply --yes` after the user's yes.
- The skill is under 150 lines and lints clean.
- It stayed local, or it was proposed according to `submit`, and never if it holds personal data.

## When something goes wrong

| Symptom | Fix |
| --- | --- |
| No stronger model available | Stop; a model can't reliably write instructions for one stronger than itself |
| The fix helps small models but hurts large ones | Make `<name>-lite` instead |
| Recording has the user's private data in it | Describe the steps in your own words; leave names, emails and IDs out |
| `skill apply` refuses the edit | Read why. A protected section must keep all its lines |

## Worked example

Haiku used `academic-research` and cited a paper that doesn't exist.

1. Cause: step 4 says "verify each candidate", and the model skipped it under a long list.
2. The author model rewrote step 4 as a fixed sequence of three calls per source, with one
   example from the reference run, and removed the "prefer reviews" judgment.
3. Haiku reran the task with the draft. All three sources resolved, none was retracted, and
   each claim pointed to a page.
4. The user said yes. Applied. `submit` was `"ask"`; the user chose to share it.
