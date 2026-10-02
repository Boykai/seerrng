---
category: changed
audience: users, operators
area: discovery-integrations
action: none
breaking: false
---
AniList requests now share one budget of about 30 per minute across every AniList feature. After AniList answers with a rate limit, SeerrNG sends nothing more until AniList's Retry-After time has passed. A request that would wait more than about 10 seconds for the budget fails fast with a rate-limit error asking you to try again later.
