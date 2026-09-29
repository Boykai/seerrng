---
category: fixed
audience: operators
area: release-pipeline
action: none
breaking: false
---
PPA publishing now recovers from Launchpad's source-publication race or a binary upload stalled for 45 minutes by signing a fresh package version, then waits for its Ubuntu binaries to publish. No Launchpad OAuth secret is needed.
