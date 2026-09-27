---
category: security
audience: users, operators
area: library
action: none
breaking: false
---

Only administrators can delete all verified copies across connected services from Manage, and the API enforces the same rule. Deletion stops when a comic’s backend is unknown. Downloads verify that opened files remain under their configured library, and malformed service filenames are parsed safely. Docker builds no longer send the host `.npmrc` to the builder.
