---
category: fixed
audience: operators
area: release-pipeline
action: Remove LAUNCHPAD_CREDENTIALS; configure GPG_PRIVATE_KEY and LAUNCHPAD_PPA if PPA publishing is enabled.
breaking: false
---
PPA publishing uses GPG_PRIVATE_KEY to sign packages and LAUNCHPAD_PPA to select the destination. LAUNCHPAD_CREDENTIALS is no longer used.
