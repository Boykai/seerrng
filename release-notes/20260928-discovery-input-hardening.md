---
category: security
audience: users, operators
area: integrations
action: none
breaking: false
---
Discovery integrations now reject malformed MDBList links and repeated list parameters before contacting providers, reducing the risk of confusing or unintended requests. Existing valid list URLs continue to work.
