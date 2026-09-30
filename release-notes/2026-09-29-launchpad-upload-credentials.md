---
category: fixed
audience: operators
area: release-pipeline
action: none
breaking: false
---
PPA publishing uses GPG_PRIVATE_KEY for package signing and LAUNCHPAD_PPA for its destination. It no longer requires a separate Launchpad OAuth credential; publication verification reads Launchpad's public API anonymously.
