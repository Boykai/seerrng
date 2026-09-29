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
- Discover now adds signed-in-user rows for Trakt recommendations and watchlists,
  AniList planning/in-progress shelves, and Simkl planning/in-progress shelves.
  Rows are limited to that user's connected providers and keep unmapped titles.
- Trakt, AniList, and MDBList discovery feeds let users confirm unmatched titles
  against TMDB, filter to the unmatched items on the current page, and change or
  reset private mappings without rewriting provider IDs.
- Exact IMDb and TVDB identifiers from Trakt, MDBList and supported personal
  libraries are resolved through TMDB when the result is unique and type-safe.
  Stale, ambiguous and unavailable matches stay in the manual repair flow; users
  can save a private override for an automatic result.
- Personal Trakt, AniList, and Simkl libraries support bounded bulk repair scans
  with progress, stop/resume, batches of up to five pages, and a 500-page cap.
  Only unique, type-safe matches from supported exact IMDb/TVDB identifiers are
  saved; titles without those identifiers remain available for manual repair.
- Users can export and import a versioned personal mapping pack without provider
  credentials. Import is bounded, transactional, idempotent, and private to the
  importing account; it can be restored before provider reconnection.
- Administrators can publish, export and remove bounded versioned title-match
  packs shared by every account on the instance. Provider identities are unique
  across shared packs, private matches take precedence, and the UI requires an
  explicit all-accounts acknowledgement before publishing and a second step
  before deleting.
- My Library browses Trakt, AniList, Simkl, Plex, Jellyfin, and Emby shelves;
  explicit watched, rating, and AniList progress writes are confirmed and
  idempotent. Trakt and Simkl also support explicit per-episode watched changes
  from the configured season list, with matched TMDB/TVDB IDs and Simkl's
  current anime-season mapping contract. Trakt and Simkl now show provider
  watched state beside each episode; Trakt's active rewatch reset is respected,
  and Simkl status reads are limited to the selected show and season. Manual
  TMDB matches are private to the current user's library.
- TV request owners can opt into Jellyfin watch-ahead when their linked Jellyfin
  user, TV-request permission, and matching Sonarr destination are available.
  The worker checks active playback every 30 seconds, requires Jellyfin to mark
  the matching episode played at or beyond 90% runtime, retains progress while
  approval is pending, and creates linked, quota-exempt Sonarr child requests
  under the parent approval to maintain a buffer of up to five missing episodes.
  Disabling watch-ahead stops future additions and leaves already-created child
  requests in place.
- Movie/series/music/book release calendar with personal/shared scopes, bounded
  cached backend reads, episode hydration and partial-source reporting across
  Radarr, Sonarr, Lidarr, and Readarr-compatible Bookshelf services. The
  calendar also shows requested PC games and emulation titles from their IGDB
  release dates, with at most 200 catalog lookups, three concurrent calls, and
  existing 10-minute provider caching per interactive calendar query. The daily
  date-history job skips these optional catalog lookups.
- Daily date-change snapshots for monitored Radarr, Sonarr, Lidarr, and
  Readarr-compatible Bookshelf releases. The calendar shows up to three recent
  moves per event; snapshots reset after long observation gaps to avoid
  presenting stale dates as fresh changes.
- Dedicated-permission download intervention inbox with durable warnings, explicit
  rejection options, existing-library matching and backend-specific manual-import
  previews for Radarr, Sonarr, Lidarr and Readarr, backend identity checks,
  command/history outcome verification and bounded action history.
- Optional Jellyfin companion plugin for a separately deployed SeerrNG server.
  The plugin adds an administrator-dashboard shortcut, validates an already-linked user's
  current session on the SeerrNG server, and supports administrator and account
  unlink revocation without replacing other media-server integrations.
  It has now been installed and exercised against the official Jellyfin 10.11.11
  container: plugin loading, authenticated settings persistence, the bridge
  configuration endpoint, administrator shortcut, and settings page pass.
- Selectable QuestarrNG or ROMarrNG IGDB catalog for emulation, with QuestarrNG
  retained for PC games and ROMarrNG for ROM acquisition. Provider actions and
  game/platform identity use the versioned SeerrNG integration contract.
- Matching OpenAPI paths, SQLite/PostgreSQL migrations and regression coverage.
- Provider discovery recovery distinguishes account reconnection, missing
  MDBList setup, unavailable public lists, quota cooldowns and temporary outages.

## Remaining work

- Verify personalized dashboard feeds, credentials, and quota recovery with
  live provider accounts.
- Verify manual-import payloads and acquisition actions against live services,
  including the supported Readarr-compatible backend variants.
- Comic issue and magazine release calendar sources remain to be evaluated; they
  need a bounded publication-date source that preserves issue and title identity.
- Additional provider-specific live resolvers beyond the exact IMDb/TVDB
  identifiers currently supported. AniList library entries do not expose either
  identifier in the current client contract, so its bulk scan does not infer
  title matches from names alone.
- AniList exposes sequential episode progress rather than individual watched
  episode identities, so its library remains count-based while Trakt and Simkl
  use provider-confirmed episode states.
- Publish the Jellyfin bridge archive and repository manifest in a SeerrNG
  release, then verify the linked-user login against a live SeerrNG/Jellyfin pair.
  CI now smoke-tests plugin loading, settings persistence, auth requirements, and
  dashboard page registration against Jellyfin 10.11.11 on every push and PR.
- Optional desktop playback with browser fallback.
- Finish end-to-end UI and deployment verification before describing parity as
  complete. A provider client or an account link alone is not parity.

Source revisions reviewed: Foreseerr `3fc9bdf47f99db32c2e777a4bbd6d8d6262a4ae3`
and Jellyfin plugin `91439d6214d0357f70c60e50259b612972998348`.
