# Attribution Notice

SeerrNG is a fork of [Seerr](https://github.com/seerr-team/seerr). Seerr is
itself built on work from the Overseerr and Jellyseerr projects.

The inherited application code, architecture, UI, documentation, and project
history remain attributed to their original authors and contributors under the
MIT license and any applicable third-party asset licenses.

Changes made after the SeerrNG fork are attributed as follows:

- Files inherited from Seerr and modified in SeerrNG are derivative work and are
  co-attributed to the upstream Seerr/Jellyseerr/Overseerr contributors and to
  snapetech and SeerrNG contributors for the fork-specific changes.
- Files, workflows, packaging, documentation, and assets created specifically
  for SeerrNG are attributed to snapetech and SeerrNG contributors unless they
  state another source or license.
- Third-party names, logos, APIs, package scopes, and service references remain
  the property of their respective owners.

Do not replace upstream attribution on inherited material. When adding fresh
SeerrNG-specific files or repo metadata, avoid presenting them as upstream
Seerr project output unless the content is explicitly documenting upstream
behavior or compatibility.

The `RemapOverseerrDeletedStatus` migration files are imported from upstream
Seerr to preserve compatibility with databases created there. Their migration
names and source issue links are retained intentionally.

## Foreseerr provider integrations

The Trakt, AniList, Simkl and MDBList clients and Trakt list pagination helpers
are adapted from [selmant/foreseerr](https://github.com/selmant/foreseerr),
revision `3fc9bdf47f99db32c2e777a4bbd6d8d6262a4ae3`.
Copyright (c) 2026 Selman Trabzon. The original MIT license is retained in
[`licenses/foreseerr-MIT.txt`](licenses/foreseerr-MIT.txt). SeerrNG changes are
attributed to snapetech and SeerrNG contributors.
