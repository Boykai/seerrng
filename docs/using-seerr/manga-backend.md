---
title: Manga Backend
description: Enable manga discovery and choose which AniList titles SeerrNG shows.
sidebar_position: 26
---

# Manga Backend

SeerrNG can show manga beside your other media. Manga discovery, search, and
details use metadata from [AniList](https://anilist.co/). Manga requests and
downloads are not available yet; downloading through Suwayomi arrives in a
later release.

## Enable manga

The Manga category is off by default, including for existing installations.

1. Open **Settings → Media Categories**.
2. Turn on **Manga** and save.

When the category is on, users see:

- a **Manga** entry in the navigation that opens the manga Discover page, with
  Trending, Popular, and Top Rated shelves, a keyword search, and sort options;
- a **Manga** category in global Search;
- manga cards with a **Manga** badge;
- a details page for each title with its alternative titles, format, status,
  chapter and volume counts, story and art credits, genres, tags, publication
  dates, and description, plus links to the title on AniList and MyAnimeList.

Turning the category off hides these entry points again and sends direct manga
pages back to Discover. See [Media categories](./settings/media-categories.md)
for how category switches work.

## Choose which titles appear

The **Manga Content** group on the same settings page has two switches. Both
are off by default and apply to everyone on the instance:

- **Include Adult Manga** includes titles that AniList marks as adult.
- **Include Novels** includes titles that AniList lists in its novel format.

While a switch is off, SeerrNG leaves those titles out of manga discovery and
search, and their details pages show the normal not-found page.

## AniList metadata

SeerrNG reads manga metadata from AniList's public catalog; no AniList account
or API key is required. Manga pages share SeerrNG's AniList request budget with
the other AniList features. While AniList is rate limiting requests, manga pages
may not load; try again later.

## Blocklist manga

Users with permission to manage the blocklist can blocklist a manga title from
its card or its details page. Blocklisted titles stay out of manga discovery and
search results and appear on the **Blocklist** page under the **Manga** filter,
where you can remove them again.

## Connect Suwayomi

SeerrNG will download manga through a
[Suwayomi](https://github.com/Suwayomi/Suwayomi-Server) server. Connecting the
server now prepares that later download support; it does not enable manga
requests yet.

1. Open **Settings → Services** and select **Add Suwayomi Server** in the
   **Suwayomi Settings** section. You can add one server.
2. Enter a server name, the hostname or IP address, and the port (Suwayomi
   uses 4567 by default). Turn on **Use SSL** if Suwayomi is served over HTTPS,
   and enter a **URL Base** if it runs under a path.
3. Enter Suwayomi's username and password if it requires a login.
4. Select **Test**. The test detects how Suwayomi authenticates, checks its
   version and the features SeerrNG needs, and loads its installed sources.
   **Add Server** stays unavailable until a test succeeds, and changing the
   address, SSL, credentials, or **Require CBZ Downloads** asks for a new test.
5. Optionally list preferred languages and scanlators, select the sources
   SeerrNG may search (the selection order is their priority), and save.

The test result lists warnings, most urgent first. SeerrNG warns when it
detects no authentication or empty configured credentials; in that case, check
Suwayomi's authentication settings. SeerrNG does not support Suwayomi's simple
login.

### Credentials and recommendations

Current Suwayomi releases have a single login, and it has full administrative
access to Suwayomi. SeerrNG stores it in plaintext in `settings.json`, or in
the `SEERR_EXTERNAL_CONFIG` environment variable if you use one; that variable
holds JSON and is not a file. If you use `SEERR_EXTERNAL_CONFIG`, export it
again with `scripts/export-external-config.mjs` after adding Suwayomi (see
[External runtime configuration](../EXTERNAL_RUNTIME_CONFIG.md)). SeerrNG never
shows the stored password again; enter it again after changing the address,
SSL, or username.

- Use Suwayomi's UI login.
- Turn on CBZ downloads in Suwayomi. While **Require CBZ Downloads** is on, the
  test fails unless Suwayomi saves downloads as CBZ files.
- Pin the Suwayomi container image by digest, so it changes only when you
  choose.
- Do not expose Suwayomi publicly; keep it on a private network that SeerrNG
  can reach.

## Library scan

The **Manga Library Scan** job reads the library of the connected Suwayomi
server. It records which AniList title each manga in that library is and how
much of it Suwayomi has downloaded. The job runs every day at 05:45; change its
schedule or run it now under **Settings → Jobs & Cache**. It does nothing
while the Manga category is off.

The scan only reads from Suwayomi and never changes anything there. It calls
no service other than Suwayomi. It covers every manga in the Suwayomi library,
whichever sources you selected for searching.

### Matching

The scan matches a manga through the AniList link that Suwayomi stores when
the manga is tracked with AniList in Suwayomi.

- Only AniList links are used for now. A manga without one, or with links to
  two different AniList titles, stays unmatched.
- A match stays in place on later scans, even if the manga's tracker link
  changes afterwards.
- SeerrNG keeps unmatched manga for review; matching them by hand arrives in a
  later release. An unmatched manga never makes a title available.

### Availability

For each matched title, SeerrNG sets the status from what Suwayomi has
downloaded:

- **Available** when Suwayomi lists at least one chapter and has downloaded all
  of them.
- **Partially Available** when it has downloaded some of them.
- With no chapter downloaded, the scan gives the title no status; SeerrNG only
  notes that the manga is in the Suwayomi library.

When Suwayomi lists the same chapter number more than once, for example from
several scanlators, the chapter counts as downloaded once any of its versions
is.

The status follows Suwayomi's own records:

- Suwayomi's download records decide what is downloaded. A chapter whose files
  were deleted outside Suwayomi still counts as downloaded.
- Suwayomi's stored chapter list decides what exists. New chapters count only
  after Suwayomi's own library update has added them.

When fewer chapters are downloaded than before, when a matched manga leaves the
Suwayomi library, or when you remove the Suwayomi server, SeerrNG lowers the
title's status to match. It does not lower the status of a title with a
pending, approved, or failed request, and it never changes a blocklisted
title. If the library changes while a scan reads it, that run marks no manga
as gone; the next run does.

Each run logs how many matches and statuses it changed, and a code for each
warning, under the **Manga Library Scan** label. These log entries contain
counts, IDs, and codes only, never titles or addresses.
