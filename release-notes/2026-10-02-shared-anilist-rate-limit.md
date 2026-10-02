---
category: changed
audience: users, operators
area: anilist
action: none
breaking: false
---
AniList requests now share one budget of about 30 per minute across every AniList feature. SeerrNG honors AniList's Retry-After, and a request that would wait more than about 10 seconds now fails fast with a 429 instead of hanging.
