---
category: changed
audience: operators
area: release-pipeline
action: none
breaking: false
---
Launchpad publishing retries only a classified source-publication race and waits through nonterminal builds instead of creating another source upload based on elapsed time. If monitoring times out, inspect the Launchpad logs.
