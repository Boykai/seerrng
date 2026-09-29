---
category: fixed
audience: operators
area: release-pipeline
action: configure LAUNCHPAD_CREDENTIALS for PPA publishing
breaking: false
---
PPA releases now wait for Launchpad to publish the matching Ubuntu source and binary packages, and retry binary uploads rejected before source publication.
