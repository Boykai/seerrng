---
category: changed
audience: operators
area: development
action: none
breaking: false
---

Ordinary commands retain upstream validation. Builds still check translations and approved visual contracts. The comprehensive runner remains available explicitly, instead of repeating every test during builds and commits. Commit-message checks use the pinned package manager to avoid an incompatible bundled npm launcher.
