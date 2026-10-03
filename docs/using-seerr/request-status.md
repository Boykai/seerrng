---
title: Request Status
description: Follow request progress, view status history, and find incomplete requests.
---

# Request Status

Open **Requests** from the account menu to see request progress. Each card
shows the current state and, when available, the request lifecycle from
approval and searching through downloading, importing, and library
availability. Expand **History** on a card to review its recorded status
changes.

## Find a request

Use the summary filters to view all requests, completed requests, active work,
requests needing attention, or incomplete requests. **Incomplete** helps find
requests where only part of the requested media or book formats have been
fulfilled.

The other filters can narrow the list by media type, keyword, and time period.
The time period options include the last 7, 14, or 30 days, the last 6 months,
and all time. If the page indicates older requests are outside the selected
period, choose **View All History** to include them. Users with permission to
view other users' requests can also filter by requester.

## Resolve requests that need attention

When a request has a **Retry** action, use it to restart the request from the
approval stage. Pending requests may also show management actions such as
approve, decline, or edit, depending on your permissions. Actions for deleting
status entries or removing available media are permission-controlled and
include a confirmation step.

For books, the Books and Audiobooks filters keep ebook and audiobook requests
separate. A combined request can therefore be incomplete while one format is
available and the other is still requested or missing. See
[Books, Authors, and Series](./books-and-series.md) for book discovery and
series requests.

## Manga requests

Manga requests show a **Manga** badge, and the **Manga** media filter lists
them on their own. Each card's **Chapters** row shows the requested chapters,
for example "All", "Latest 25", "10–20", or "10 onward". An
approved manga request whose title has no current match on the Suwayomi server
shows **Waiting for a source** instead of **Approved**; see
[Manga Backend](./manga-backend.md#waiting-for-a-source). Administrators
choose its source on the
[Manga Sources page](./manga-backend.md#resolve-sources-by-hand), which the
**Choose Source** button beside the status opens. SeerrNG sends approved manga
requests to Suwayomi; see [Dispatch](./manga-backend.md#dispatch).

## Follow new chapters

A manga request gets the matching chapters that its source lists when SeerrNG
sends it. To also get matching chapters that the source adds later, the
requester can set **Follow New Chapters** to **On** on the request's card. It
is **Off** by default. SeerrNG then checks for new chapters from time to time
and queues them for download. A completed request shows **Downloading** again
while new chapters arrive, and SeerrNG sends the **Request Available**
notification again once they are delivered. New chapters use the request's
approval and do not count against your request quota.

Only the requester can turn following on, while the request is pending,
approved, or complete. The requester or a user with the **Manage Requests**
permission can turn it off. Turning it off stops further additions; chapters
already added still download.

When following stops or pauses, the request card says why. It stops when the
request is declined or fails, when the requester can no longer request manga,
when the request has the last chapter of its range, or when it reaches 10,000
chapters. A paused request keeps following: SeerrNG checks again every day,
and an administrator can fix the cause, for example by reviewing the title's
match under **Settings → Manga Library**. See
[Follow new chapters](./manga-backend.md#follow-new-chapters) for how often
SeerrNG checks and which chapters it adds.

## Download an available copy

When an imported file is available to SeerrNG, its request card shows a
**Download copy** action. If the request has several files, open **Download
copies** and choose the episode, book format, comic issue, or magazine issue to
save. The browser handles transfer progress after the download starts; SeerrNG
keeps the request's availability and history on this page.

Manga chapters become downloadable one at a time, as soon as SeerrNG verifies
each one in Suwayomi, while the rest of the request is still downloading and
also after the request failed. Each chapter downloads as its own CBZ file, and
newly verified chapters join the list without reloading the page. There is no
**Download all**. Manga chapters need no path mapping; see
[Download copy](./manga-backend.md#download-copy) for the limits.

ROM and PC game requests also appear in Request Status with their provider
confirmed lifecycle states and download actions. See
[Software requests](./software-acquisition.md) for provider setup, emulation
system groups, and PC target selection.

Available notifications link directly to the matching request in Request
Status. Software requests are reconciled in the background, so completion can
be detected when the page is closed. SeerrNG checks request access and current
availability again before each download. It
does not expose provider credentials or server paths, and it only lists files
that the configured backend reports as imported and SeerrNG can access.

### Administrator setup

In **Settings > Main > Download Copies**, add a path mapping for file-based
backends. The backend's `remoteRoot` is the library root it reports; `localRoot`
is the corresponding absolute path mounted read-only inside SeerrNG. Use an
instance-specific `serviceId` when more than one backend of that type uses
different paths. For example:

```json
[
  {
    "serviceType": "radarr",
    "serviceId": 1,
    "remoteRoot": "/movies",
    "localRoot": "/mnt/media/movies"
  }
]
```

Mappings are supported for Radarr, Sonarr, Readarr-compatible ebook and
audiobook services, LazyLibrarian magazines, and Kapowarr comics. Mylar3 comic
issues are streamed through its authenticated API and do not need a path
mapping. Keep the mounted library read-only and map the narrowest practical
folder. If the backend does not report an imported file, the path is not
mounted, or a mapping cannot be resolved safely, the download action stays
hidden.
