---
category: fixed
audience: operators
area: release-pipeline
action: none
breaking: false
---
PPA releases now wait for Launchpad to publish the matching Ubuntu source and binary packages, and retry binary uploads rejected before source publication. This requires no Launchpad OAuth credential.
