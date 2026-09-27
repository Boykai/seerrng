# Comic and software discovery parity audit (2026-09-27)

This audit compares the current comic, ROM, and PC game discovery paths with movie and TV discovery. It records implemented behavior and remaining product gaps; provider live availability was not tested.

| Capability | Movies and TV | Comics | ROMs and PC games |
| --- | --- | --- | --- |
| Catalog lookup | TMDB discover and search | ComicVine volume search | QuestarrNG IGDB search and popular; ROMarrNG systems constrain ROM requests |
| Incremental results | Paginated `useDiscover` list | Paginated `useDiscover` volume search and lazy, paged back-issue list | Cursor-paged search and offset-paged popular titles with platform, genre, and release-year filtering in the current QuestarrNG contract; older builds retain the first window |
| Returning from details | Loaded pages and scroll restored | Loaded pages and scroll restored | Software title details have a shareable catalog URL; closing details keeps the current catalog list in memory |
| Metadata cache | Bounded TMDB cache | Bounded ComicVine cache | Bounded 10-minute QuestarrNG catalog cache and 5-minute ROMarrNG system cache |
| Covers | Lazy browser images, optional image proxy, bounded prewarming | Same path for ComicVine hosts | Same path for IGDB covers; detail screenshots load only when opened |
| Request progress and availability | Shared media request lifecycle | Shared media request lifecycle | Dedicated durable software request lifecycle and request status cards; bounded provider library lookups show existing QuestarrNG and ROMarrNG availability on catalog titles |

## Remaining gaps

1. **Paged provider rollout.** QuestarrNG's [SeerrNG integration API](https://github.com/snapetech/QuestarrNG/blob/main/docs/API.md#seerrng-software-provider-contract) now includes paged search and popular endpoints with platform, genre, and release-year filters. SeerrNG falls back to the first 50-title window against older QuestarrNG builds for unfiltered browsing. Filtered browsing requires the current contract. Verify a deployed QuestarrNG build before treating live software paging as complete.
2. **Comic discovery controls.** Comics have keyword search and paged volume results, but no full-catalog publisher, year, or issue-count controls. A filter over one fetched page would give incomplete results. This needs a provider-supported query or a maintained local volume index.
3. **Provider rollout and incomplete inventories.** Existing QuestarrNG and ROMarrNG library availability appears after both providers expose their bounded lookup contracts. ROMarrNG reports when its cache is still loading or partial, so unmatched titles remain unknown until its library is complete. Live provider behavior still needs deployment verification.

ComicVine volume discovery and back-issue browsing are paged and cached. Requests acquire full volumes, matching the selected product scope.
