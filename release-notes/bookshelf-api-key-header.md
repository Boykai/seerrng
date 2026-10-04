---
category: security
audience: operators
area: bookshelf
action: none
breaking: false
---

BookshelfNG connections now send API keys in the `X-Api-Key` header, so servers that reject query-string keys can be tested and used successfully. API keys are no longer added to request URLs.
