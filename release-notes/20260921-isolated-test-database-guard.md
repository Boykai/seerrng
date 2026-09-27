---
category: fixed
audience: operators
area: development
action: Start Vitest with NODE_ENV=test and a separate test configuration directory.
breaking: false
---
Vitest now refuses to run against a disk-backed database, preventing inherited development settings from directing test resets at a preview database.
