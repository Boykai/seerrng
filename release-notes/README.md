# Release-note fragments

Add one Markdown fragment for every user-facing pull request. The release
workflow carries these fragments into `CHANGELOG.md`, GitHub Releases, and the
Discord release announcement.

Use a short, user-facing description rather than an implementation detail:

```md
---
category: fixed
audience: users, operators
area: bookshelf
action: none
breaking: false
---
Hardcover-backed book searches now keep working from cached metadata during a short upstream outage.
```

The frontmatter captures the context that is usually lost during a release:

- `category`: `added`, `changed`, `fixed`, `security`, `removed`, or `deprecated`.
- `audience`: `users`, `operators`, or `users, operators`.
- `area`: a short lowercase slug such as `bookshelf`, `metadata`, or
  `release-pipeline`.
- `action`: the required upgrade or operating step, or `none` when no action is
  needed.
- `breaking`: `true` or `false`; breaking changes must include an action.

The body is the release-ready summary: state what changed and why it matters to
the audience. Keep it to 30-400 characters, start with a capitalized sentence,
and end with punctuation. Do not paste commit messages, logs, issue fragments,
or implementation-only details.

Released fragments are immutable. You may refine an upcoming release fragment
before its version tag; after tagging, add a new file instead of rewriting the
shipped history. Preview the exact notes that will be published with:

```bash
pnpm release-notes:preview --base origin/main --head HEAD
```

If a pull request is entirely internal and has no user-visible effect, select
the internal-only release-note option in the pull request template or add
`release-note: none` to the description. Do not use that opt-out to avoid
describing a feature, bug fix, security change, operational behavior, or
user-facing documentation change.

For an internal-only commit pushed directly to `main` (including a merge whose
new diff contains only internal work), add `release-note: none` to the commit
message. Push validation uses the commit message when no pull-request body is
available.
