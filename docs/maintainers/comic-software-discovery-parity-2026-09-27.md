# Comic and software discovery parity audit (2026-09-27)

This audit compares the current comic, ROM, and PC game discovery paths with movie and TV discovery. It records implemented behavior and remaining product gaps; provider live availability was not tested.

| Capability | Movies and TV | Comics | ROMs and PC games |
| --- | --- | --- | --- |
| Catalog lookup | TMDB discover and search | ComicVine volume search | QuestarrNG IGDB search and popular; ROMarrNG systems constrain ROM requests |
| Incremental results | Paginated `useDiscover` list | Paginated `useDiscover` volume search and lazy, paged back-issue list | Cursor-paged search and offset-paged popular titles with platform filtering when QuestarrNG supports the new contract; older builds retain the first window |
| Returning from details | Loaded pages and scroll restored | Loaded pages and scroll restored | Software title details have a shareable catalog URL; closing details keeps the current catalog list in memory |
| Metadata cache | Bounded TMDB cache | Bounded ComicVine cache | Bounded 10-minute QuestarrNG catalog cache and 5-minute ROMarrNG system cache |
| Covers | Lazy browser images, optional image proxy, bounded prewarming | Same path for ComicVine hosts | Same path for IGDB covers |
| Request progress | Shared media request lifecycle | Shared media request lifecycle | Dedicated durable software request lifecycle and request status cards |

## Remaining gaps

1. **Paged provider rollout.** QuestarrNG's [SeerrNG integration API](https://github.com/snapetech/QuestarrNG/blob/main/docs/API.md#seerrng-software-provider-contract) now includes paged search and popular endpoints with optional platform IDs. SeerrNG falls back to the first 50-title window against older QuestarrNG builds. Verify a deployed QuestarrNG build includes the new endpoints before treating live software paging as complete.
2. **Discovery controls.** Comics have keyword search but no publisher, year, or issue-count controls. Software has keyword search, Retro/Modern/PC groups, and system or PC operating-system filters, but no release-date or genre controls. Add only filters supported by the upstream catalog contract, with server-side filtering before pagination.
3. **Richer game details.** Software titles have shareable catalog detail URLs, a scoped global Search category, and an All-search preview. The detail panel has catalog metadata and target selection; it does not yet show a trailer, screenshots, or reviews.
4. **Availability outside requests.** Software request status tracks SeerrNG-created acquisitions. The catalog does not yet merge an existing QuestarrNG or ROMarrNG library inventory into per-title availability the way movie and TV cards do with their media libraries.

ComicVine volume discovery and back-issue browsing are paged and cached. Requests still acquire full volumes; issue-specific acquisition needs a request model that distinguishes an issue from its parent volume.
