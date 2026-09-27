---
category: changed
audience: users, operators
area: library
action: Review request and issue retention before enabling availability sync after upgrading.
breaking: true
---
Availability sync now cleans up confirmed movie and series removals. Remaining qualities, blocklists and watchlists are preserved. When the last copy is gone, requests and issues are deleted and unneeded media records are removed. Failed or inconclusive service checks leave records unchanged.
