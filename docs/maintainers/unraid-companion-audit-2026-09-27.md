# Unraid companion template audit (2026-09-27)

The SeerrNG Community Apps template remains a single standalone container. Community Apps Docker templates configure one container at a time. Only our three NG forks have separate companion XML templates in this repository; the upstream apps use their existing Community Apps listings. The Compose project remains an alternate deployment path.

| Companion template | Image | Existing Community Apps entry | Standalone check |
| --- | --- | --- | --- |
| BookshelfNG | `ghcr.io/snapetech/bookshelfng:hardcover` | [Upstream Bookshelf](https://ca.unraid.net/apps/bookshelf-1d1gz3s0hj3af8) | Fresh config; web UI HTTP 200 |
| LazyLibrarian | `lscr.io/linuxserver/lazylibrarian:latest` | [LazyLibrarian](https://ca.unraid.net/apps/lazylibrarian-1o5cqti19ivs1e) | Fresh config; authors UI HTTP 200 |
| Mylar3 | `lscr.io/linuxserver/mylar3:latest` | [Mylar3](https://ca.unraid.net/apps/mylar3-1avghds0trt4q4) | Fresh config; home UI HTTP 200 |
| Kapowarr | `mrcas/kapowarr:latest` | [Kapowarr](https://ca.unraid.net/apps/kapowarr-1p27chu0mk08ni) | Fresh config; web UI HTTP 200 |
| ROMarrNG | `ghcr.io/snapetech/romarrng:latest` | No NG fork entry located | Fresh folder library; health HTTP 200 |
| QuestarrNG | `ghcr.io/snapetech/questarrng:latest` | [Upstream Questarr](https://ca.unraid.net/apps/questarr-0335hnh1oyuaqh) | Fresh config; health HTTP 200 |

Each image was started independently without SeerrNG on a local Docker host. The service and its temporary data volume were removed after checking. Metadata lookup and acquisition were not exercised because these require personal provider credentials and configured download clients. BookshelfNG's current fork supports ebooks and audiobooks in one instance; both SeerrNG service entries can point to its single API URL and key.

BookshelfNG, ROMarrNG, and QuestarrNG template names include `-SeerrNG` so they remain distinguishable from upstream Community Apps entries. Their support links point to the SeerrNG issue tracker. The LazyLibrarian, Mylar3, and Kapowarr templates were removed because we do not fork those apps and their Community Apps listings already exist. Community Apps ingestion is separate from pushing XML to GitHub; submit the remaining templates through the portal and verify the public listings after its scan.
