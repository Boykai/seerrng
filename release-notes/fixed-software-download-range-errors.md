---
category: fixed
audience: users, operators
area: software
action: none
breaking: false
---
Invalid or out-of-bounds game download resume ranges now return HTTP 416 instead of a generic provider failure. ROMarrNG and QuestarrNG error bodies remain private, while clients receive the file size needed to restart the transfer.
