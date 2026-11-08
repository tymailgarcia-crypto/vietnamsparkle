# Template boundaries and review preparation

Ty states that he retains ownership of the reusable delivery application and will
give the operator a personalized implementation. Current work uses test data.
This does not replace any deployment agreement or third-party component license.

Keep business data, cloud projects and credentials separate. Coding-session
fixtures must be fictional; do not connect review sessions to a business project.

For Alignerr, disclose the retained template ownership, personalized handover and
fictional-data environment. Their exclusion of projects processing others'
personal data still needs their interpretation. No eligibility approval is
claimed. Participants must write their own ratings without AI assistance.

## Concrete next engineering tasks

1. Extract business identity, contact channels and branding into documented
   configuration while preserving the deployed implementation.
2. Extend the local preview into a full callable demo with fictional customers
   and orders, deterministic dates and disabled external integrations.
3. Verify concurrent delivery/payment retries and document their invariants.
4. Reconcile deployed-but-uncommitted work with authoring sessions, prepare a
   reproducible release and capture screenshots using fictional fixtures.

These are proposed tasks, not completed functionality. Production rule changes
and business behavior changes require separate focused work.

## Preparation verification — 2026-11-08

- Five focused suites pass against both the current working files (73 checks)
  and the pre-preparation Git version (82 checks). Their different counts reflect
  existing uncommitted changes, not additional tests created for this preparation.
- Auth, Firestore, Storage and Hosting emulators started with the demo project.
  HTTP checks confirmed the served demo configuration, fictional owner login and
  two products read through the Firestore rules. A remote seed host was rejected.
- Verification used this machine's Node 24 and Java 21; the documented Node 22
  release runtime and WSL2 environment were not independently verified here.
- No browser screenshot review, full callable lifecycle, deployment or Alignerr
  eligibility approval is implied by these checks.
