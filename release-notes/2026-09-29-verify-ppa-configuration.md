---
category: fixed
audience: operators
area: release-pipeline
action: Remove LAUNCHPAD_CREDENTIALS; configure GPG_PRIVATE_KEY and LAUNCHPAD_PPA.
breaking: false
---
Correction to the earlier PPA setup note: publishing does not read LAUNCHPAD_CREDENTIALS. Remove that obsolete value; releases use GPG_PRIVATE_KEY to sign packages and LAUNCHPAD_PPA to select the destination.
