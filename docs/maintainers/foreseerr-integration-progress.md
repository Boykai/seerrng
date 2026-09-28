# Foreseerr integration implementation

Approved scope covers discovery providers, calendar, queue intervention, personal
library and tracking, identity and episode mappings, watch-ahead, an optional
Jellyfin bridge to a separate SeerrNG server, and optional native playback.

## Implemented foundation

- Adapted MIT-licensed Trakt, AniList, Simkl and MDBList clients with attribution.
- Bounded provider caches, private cache isolation and Trakt read coalescing.
- Application credentials managed by administrators; secret values never returned.
- Personal account storage, server-owned device flows, AniList PIN exchange,
  account disconnect and explicit write-consent storage.
- Provider discovery pages for Trakt, AniList and MDBList; known TMDB IDs use
  existing lazy title-card hydration. Unmatched candidates are displayed as such.
- Matching OpenAPI paths, SQLite/PostgreSQL migrations and regression coverage.

## Remaining work

- Complete provider feeds, personalized dashboard rows, ratings integration and
  credential/quota failure recovery; verify with live provider accounts.
- Release calendar and permission-controlled queue intervention inbox.
- Personalized library shelves and explicit watched/rating writes.
- Provenance-aware identity and episode mappings, mapping packs and gap repair.
- Opt-in rolling watch-ahead, durable scheduling and episode progress handling.
- Optional Jellyfin plugin using the independently deployed SeerrNG server,
  server-validated sessions and revocation, preserving existing media servers.
- Optional desktop playback with browser fallback.
- Finish end-to-end UI and deployment verification before describing parity as
  complete. A provider client or an account link alone is not parity.

Source revisions reviewed: Foreseerr `3fc9bdf47f99db32c2e777a4bbd6d8d6262a4ae3`
and Jellyfin plugin `91439d6214d0357f70c60e50259b612972998348`.
