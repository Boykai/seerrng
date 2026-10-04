---
category: changed
audience: users, operators
area: discovery-integrations
action: none
breaking: false
---
AniList requests now share one budget of about 30 per minute across all AniList features. After AniList reports a rate limit, SeerrNG sends nothing more until its Retry-After time has passed. A request that would wait more than about 10 seconds fails immediately. Discovery feeds show when to retry; library, tracking and account-linking actions show their usual error, so try again later.
