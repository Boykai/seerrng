# Movie and series metadata providers

Movie and series detail requests build one response from separate source
snapshots. SeerrNG keeps field-level provenance so the title, description,
release date, genres, runtime, status, studios, networks, directors, writers,
and external IDs can be traced to the provider that supplied them. Stable
provider IDs are matched first. Title matching is used only when it produces one
exact title and compatible year match.

## Providers

| Provider | Movies | Series | Data and use |
| --- | --- | --- | --- |
| TMDB | Yes | Yes | Primary structured details, credits, ratings, and artwork. Other providers fill missing text fields; TMDB remains the configured primary provider unless TVDB is selected for series or anime. |
| TheTVDB | Yes | Yes | Independent title, description, dates, genres, runtime, status, studio/network, and external-ID fallback. SeerrNG links directly to the matching TheTVDB record. |
| TVmaze | No | Yes | Independent title, summary, dates, genres, runtime, network, and external IDs. Its API data is licensed under CC BY-SA 4.0. SeerrNG does not use TVmaze artwork. |
| Wikidata | Yes | Yes | Structured descriptions, dates, genres, runtime, production companies, directors, writers, and external IDs. Wikidata structured data is CC0. |

IMDb's downloadable datasets are not used as a metadata source. Their free-data
terms do not allow republishing the data as a multi-user movie database. IMDb
identifiers received from other providers are stored only as identifiers.

## Matching and fallback

Movie and series detail requests use their existing TMDB ID as the canonical
SeerrNG route ID. SeerrNG loads unexpired snapshots from all matching providers,
then refreshes any stale provider records independently and in parallel. A TMDB
outage therefore does not block a matching TheTVDB or Wikidata record from
filling a detail response. TVmaze can match series through TVDB, IMDb, or an
exact title and premiere date. Provider failures are isolated; one unavailable
source does not discard records returned by the others.

TMDB keeps its existing primary-field priority. Selecting TheTVDB for series or
anime keeps its existing priority for those types. Arrays such as genres,
studios, and networks are combined across matching snapshots without duplicate
names. Each response includes source links and field-level provenance. When a
provider supplies names without TMDB catalog IDs, SeerrNG displays them as text
instead of making a broken discovery link.

Movie and series title search and discovery continue using their existing TMDB
catalog calls. The multi-source catalog is used when SeerrNG loads a movie or
series detail record by its canonical ID; it does not substitute unrelated
search matches when TMDB search is unavailable.

## Caching and attribution

Every durable provider snapshot expires after six calendar months, with month-end
dates clamped to the last day of the target month. Provider snapshots refresh
before expiry (TMDB, TheTVDB, and Wikidata every 30 days; TVmaze every 7 days).
Expired records are never merged into detail responses and are removed during
catalog maintenance. The searchable local summary follows the earliest source
expiry and is cleared when it expires.

- TMDB artwork uses the approved TMDB logo and the required notice on
  **Settings > About**: “This product uses TMDB and the TMDB APIs but is not
  endorsed, certified, or otherwise approved by TMDB.” TMDB source links appear
  on movie and series details. TMDB API data is not cached beyond six months.
- TheTVDB attribution links directly to the matching record; its terms are
  linked from the detail attribution.
- TVmaze detail attribution identifies the adapted metadata and links both its record and the CC BY-SA 4.0 license.
- Wikidata attribution links to the entity and to the CC0 dedication.

Images from TheTVDB and TVmaze are not copied into the catalog. Only metadata
whose source and attribution can be identified is merged into the response.
