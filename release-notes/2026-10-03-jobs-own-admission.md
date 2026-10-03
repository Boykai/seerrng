---
category: fixed
audience: operators
area: settings
action: none
breaking: false
---
On PostgreSQL, scheduled jobs now always take their own database locks. Before, a job started with **Run Now** or a full Plex or Jellyfin scan from the settings reused the locks of that request, so it could fail or run without locks. After a job's schedule was changed, or after the first admin sign-in on a new install, later scheduled runs could keep failing until SeerrNG restarted.
