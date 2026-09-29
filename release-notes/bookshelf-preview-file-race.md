---
category: security
audience: operators
area: bookshelf
action: Run CLI apply on Linux or macOS; Windows users can apply saved previews through the web UI or administrator API.
breaking: true
---
The Bookshelf path-move CLI now opens saved preview files without following symbolic links, preventing a substituted file from redirecting an administrator API key. Windows CLI apply is disabled because Node.js does not provide the required no-follow open flag there.
