---
category: fixed
audience: operators
area: release-pipeline
action: Configure GPG_PRIVATE_KEY and LAUNCHPAD_PPA for PPA publishing.
breaking: false
---
PPA publishing reads GPG_PRIVATE_KEY for signing and LAUNCHPAD_PPA for its destination. It does not read LAUNCHPAD_CREDENTIALS; remove that obsolete setting and configure the current signing key and PPA destination instead.
