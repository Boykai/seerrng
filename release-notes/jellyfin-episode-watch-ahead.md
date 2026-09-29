---
category: added
audience: users, operators
area: requests
action: none
breaking: false
---
Jellyfin-linked TV request owners can opt into keeping up to five upcoming episodes requested in Sonarr as they watch. SeerrNG checks playback every 30 seconds by default, adds quota-exempt episodes after the parent request is approved, and matches requests by TVDB identity. Turning the buffer off stops future additions; episodes already requested remain in Sonarr.
