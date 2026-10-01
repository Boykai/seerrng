---
category: changed
audience: users, operators
area: distribution
action: Update manually configured container images to ghcr.io/snapetech/seerrng.
breaking: true
---
SeerrNG's repository and GHCR publisher have returned to `snapetech` after the YunoHost-Apps transfer. The current image is `ghcr.io/snapetech/seerrng`; operators who switched custom image references to the interim `ghcr.io/yunohost-apps/seerrng` path should switch back. YunoHost installs continue to use their separate package repository.
