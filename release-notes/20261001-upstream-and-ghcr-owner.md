---
category: changed
audience: users, operators
area: distribution
action: Update manually configured container images to ghcr.io/snapetech/seerrng.
breaking: true
---
The upstream container is published at `ghcr.io/snapetech/seerrng`, matching the restored repository owner. Operators who configured the former `ghcr.io/yunohost-apps/seerrng` path must update it; package-managed YunoHost installs continue to use their package repository.
