---
category: fixed
audience: operators
area: database
action: none
breaking: false
---
On PostgreSQL, a request or a settings change that uses a service such as Radarr, Sonarr or Suwayomi can no longer wait forever on a background task that uses the same service. Before, both could stall until SeerrNG restarted.
