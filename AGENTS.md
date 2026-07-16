# Working agreement for agents

Read this before you touch anything. It is short on purpose.

**Two agents work this repo — Claude Code and Codex — and they share ONE working
directory on Ty's machine.** Not a branch each. Not a worktree each. The same
folder, at the same time. Files change under you while you read them.

This is not hypothetical. On 2026-07-16 a Claude session and a Codex session
were editing `adminApp.js`, `receivablesApp.js`, `styles.css`, `admin.html` and
`receivables.html` simultaneously, and neither knew. Three things nearly went
wrong: a commit that would have swept up the other agent's half-finished work, a
deploy that published it to the live site, and an hour of confusion over who
wrote which line. Everything below exists because of that.

## The live board

`.agent-status.md` (git-ignored, this machine only) is where you say what you are
touching. It is the only thing standing between you and the other agent. It is
advisory — nothing enforces it — so it is worth exactly as much as your
willingness to update it.

**Start of session, in this order:**
1. `git status` — see what is already dirty. Anything modified that you did not
   modify belongs to the other agent, or to an abandoned session.
2. Read `.agent-status.md`. Respect live claims.
3. Add your own claim. Say which files/areas and roughly what you intend.

**End of session (or when you stop touching an area): remove your claim.** A
stale claim is worse than no claim, because the next agent believes it.

**Breaking a stale claim.** If a claim is more than ~4 hours old and nothing in
those files has changed recently, treat it as abandoned: take it, and write in
the board that you did and why. Agents crash and leave locks behind. Do not let a
dead claim block real work — but do not silently overwrite a live one either.

## Rules that cost us real time

- **Only ever commit your own changes.** Never `git add -A`, never `git commit
  -a`. If a file contains both your work and theirs, do not commit it whole and do
  not "clean up" their half. Stage only your hunks — recipe below.
- **Never commit a file you did not edit**, however tempting it looks.
- **`firebase deploy --only hosting` publishes the entire `firebase/web/`
  directory** — including the other agent's unfinished, uncommitted files. There
  is no partial hosting deploy. Before deploying: check `git status`, check the
  board, and if the other agent has live work in `web/`, either wait or accept and
  say so. Log every deploy on the board.
- **Rules and infra deploys are narrower and safer.** `--only storage`,
  `--only firestore:rules`, `--only functions` touch only their own file, so they
  do not drag in anyone's WIP. Prefer scoping your deploy.
- **Do not deploy `firestore:rules` unless you edited it.** It is the most
  dangerous file in the repo; see ROADMAP → "Audit follow-ups → Critical".
- **Codex's work is often uncommitted for days.** Do not assume "not in git" means
  "not real" or "safe to overwrite" — `order.html` was live in production while
  being untracked by git.

## Staging only your own hunks

When a file has both agents' work in it, this stages yours and leaves theirs
alone. It works off the index, so it is safe even while the other agent writes to
the working tree:

```bash
git diff HEAD -- path/to/file > mine.patch   # then delete the hunks that aren't yours
git apply --cached mine.patch                # stages only what's left
git diff --cached                            # confirm before committing
```

Then verify the staged result actually works — it is a combination that never ran:

```bash
git show ":path/to/file" | node --input-type=module --check   # for JS
```

Leave their hunks unstaged. `git status` will still show the file as modified
afterwards. That is correct, not a mistake.

## Where the real state lives

- **[HANDOFF.md](HANDOFF.md)** — read first. Environment traps that each cost an
  hour, and what shipped recently.
- **[ROADMAP.md](ROADMAP.md)** — history and the open list. Audited against the
  code; trust it over your assumptions.
- **`.agent-status.md`** — who is doing what *right now*.

When something ships, add a `Shipped 2026-MM-DD:` bullet to ROADMAP. When you
remove something for a reason, say why and say "do not restore" — an account
takeover survived a week because the roadmap described it as a fix.

## If you find a bug outside your task

Write it up where the next person will hit it. Do not fix it in passing,
especially in `firestore.rules`, where a "small cleanup" can change who is
allowed to claim a customer account.

## The honest limits of this file

A text file cannot stop two agents editing the same line. It only helps if both
sides read and update it. The real fix is a git worktree or branch per agent, so
the filesystem enforces the separation instead of a table asking nicely. That is
a bigger workflow change and Ty has not asked for it; until then, this is the
cheap version, and the cheap version only works if you actually use it.
