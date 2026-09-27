---
category: fixed
audience: users
area: collections
action: none
breaking: false
---
Music and TV collections quietly retry failed rating requests in the background with increasing delays, preserving loaded ratings without an error banner. Retries pause while the tab is hidden or offline and stop when leaving the page. Confirmed absent ratings do not keep retrying.
