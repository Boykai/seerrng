---
category: changed
audience: contributors
area: development
action: none
breaking: false
---

Ordinary test, development, build and commit commands retain the upstream validation workflow. Builds continue to check translations and the approved visual contracts. The comprehensive local test runner remains available explicitly for later reconciliation; it no longer repeats the complete suite during each build and commit. Commit-message checks use the project's pinned package manager rather than the container's incompatible bundled npm launcher.
