---
category: fixed
audience: operators
area: release-pipeline
action: none
breaking: false
---
PPA publishing now recovers from Launchpad's source-publication race by signing a fresh package version with the existing upload key, then waits for its Ubuntu binaries to publish. No Launchpad OAuth secret is needed.
