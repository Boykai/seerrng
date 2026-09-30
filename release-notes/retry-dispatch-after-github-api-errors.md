---
category: fixed
audience: operators
area: release-pipeline
action: none
breaking: false
---
Release publishing now keeps waiting for package jobs through temporary GitHub API errors, instead of ending before their result is known.
