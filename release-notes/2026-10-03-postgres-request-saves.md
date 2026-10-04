---
category: fixed
audience: operators
area: database
action: none
breaking: false
---
On PostgreSQL, retrying a failed request now keeps it approved, and the status counts on the Requests page load. Requests are sent to their service, and notifications go out, only after the change is saved. Before, a retry could leave the request failed while reporting success, and the counts did not load.
