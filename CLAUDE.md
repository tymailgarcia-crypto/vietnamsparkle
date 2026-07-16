# CLAUDE.md

**Read [AGENTS.md](AGENTS.md) first.** Codex works this repo at the same time as
you, in the same working directory, and AGENTS.md is the working agreement that
keeps you from committing or deploying over each other. Then check
`.agent-status.md` for what is in flight right now, and claim what you touch.

Water-delivery ops app (Da Nang). Firebase hosting + Firestore + Functions,
project `vietnamsparkle-36dfe`, code in `firebase/`. Private repo:
github.com/tymailgarcia-crypto/vietnamsparkle.

- **[HANDOFF.md](HANDOFF.md)** — read before starting. Environment gotchas that
  each cost an hour, plus what shipped recently.
- **[ROADMAP.md](ROADMAP.md)** — history and the open list. Both were audited
  against the code; trust them over your assumptions about how this app works.

Hard constraint: before touching `firestore.rules` or `canLinkAuthUidToCustomer`
in `adminApp.js`, read "Audit follow-ups → Critical" in ROADMAP.md and run the
suites in `firebase/rules-tests/`. They pin an account takeover shut. If one
fails, the takeover is back — fix the code, never the test. Read the emulator's
stderr, not just the pass count.
