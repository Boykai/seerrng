---
category: changed
audience: operators
area: jellyfin
action: Set Jellyfin as the active media server and enable media-server sign-in before enabling bridge sign-in.
breaking: false
---
SeerrNG now enables Jellyfin bridge sign-in only when Jellyfin is the active media server and media-server login is available. The Jellyfin settings page shows these prerequisites, preventing a switch that appears enabled but cannot authenticate users.
