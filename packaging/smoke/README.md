# Package Smoke

`packaging/smoke/package-smoke` validates public post-release channels by
installing or pulling from the published channel and writing `evidence.json`,
`junit.xml`, and logs under `artifacts/package-smoke/`.

Example:

```bash
packaging/smoke/package-smoke seerrng github-archive v0.1.0 --arch amd64
```

The harness is intended for internal GitLab post-release validation. The GitHub
workflow is intentionally manual-only.

Chocolatey smoke is limited to Windows x64 and checks that the installed
`SeerrNG` service responds on the configured health endpoint.

For SeerrNG, `packaging/smoke/project.env` is the source of truth for enabled
channels. The harness rejects generic channel names that are not actually
published, rejects unsupported architecture/channel combinations, and verifies
SHA-256 sidecars before installing release archives or packages.
