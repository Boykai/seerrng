---
category: fixed
audience: operators
area: release-pipeline
action: none
breaking: false
---
PPA publishing uses the existing GPG signing key and PPA target; it no longer requires a separate Launchpad OAuth credential. Publication verification reads Launchpad's public API anonymously.
