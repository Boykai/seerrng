---
category: fixed
audience: operators
area: release-pipeline
action: Remove LAUNCHPAD_CREDENTIALS; configure GPG_PRIVATE_KEY and LAUNCHPAD_PPA if PPA publishing is enabled.
breaking: false
---
PPA publishing uses GPG_PRIVATE_KEY for signing and LAUNCHPAD_PPA as its destination. Do not configure LAUNCHPAD_CREDENTIALS; publishing and verification do not use it.
