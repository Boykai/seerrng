---
category: fixed
audience: operators
area: release-pipeline
action: none
breaking: false
---
Ubuntu PPA releases now retry with a fresh signed package if Launchpad accepts an upload but fails to publish its source record, preventing package jobs from waiting until their full timeout.
