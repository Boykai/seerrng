---
category: changed
audience: operators
area: release-pipeline
action: Check Chocolatey and Snap for package availability before updating through those stores.
breaking: false
---
GitHub release publication now proceeds after required artifact and security gates even if Chocolatey or Snap Store submission fails. Check each store for its package's current version; direct release downloads remain available.
