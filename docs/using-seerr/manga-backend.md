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

The scan only reads from Suwayomi and never changes anything there. It covers
every manga in the Suwayomi library, whichever sources you selected for
searching. To match manga that Suwayomi has no AniList link for, it also sends
lookups to AniList and MangaDex; see
[Lookups on AniList and MangaDex](#lookups-on-anilist-and-mangadex).

### Matching

The scan tries these steps in order and stops at the first that matches:

1. **AniList tracking:** the AniList link that Suwayomi stores when the manga
   is tracked with AniList in Suwayomi.
2. **MyAnimeList tracking:** for a manga tracked with MyAnimeList, the AniList
   title that AniList lists for that MyAnimeList ID.
3. **MangaDex link:** for a manga whose address in Suwayomi has the form
   `/manga/<UUID>`, the AniList link that MangaDex lists for that UUID.
4. **Title proposal:** SeerrNG searches AniList for the manga's title and keeps
   the closest result as a proposal for an administrator. A proposal never
   matches a manga by itself.

- When step 1 finds no match and the manga's tracker records disagree, naming
  two different AniList titles or two different MyAnimeList IDs, steps 2 and 3
  are skipped and the manga only gets a proposal.
- When AniList lists two or more titles for one MyAnimeList ID, step 2 matches
  nothing, even when an administrator rejected all but one of them, and steps
  3 and 4 still run.
- SeerrNG never matches or proposes a title that an administrator rejected for
  that manga.
- A match stays in place on later scans, even if the manga's tracker records
  change afterwards.
- SeerrNG keeps unmatched manga and their proposals for review; reviewing them
  arrives in a later release. An unmatched manga never makes a title
  available.

A proposal is ranked by how closely the manga's title matches the result's
romaji, English, native, or alternative titles:

- **High:** at least 92% similar and at least 5 percentage points ahead of the
  next result.
- **Medium:** at least 75% similar, but not High.
- **Low:** less than 75% similar; SeerrNG keeps the best of these as a weak
  guess.

Title searches follow the **Manga Content** switches, so the scan never
proposes a title that manga discovery hides. Steps 1 to 3 match any title.

### Lookups on AniList and MangaDex

To match manga, the scan sends:

- to AniList, the MyAnimeList IDs of unmatched manga that are tracked with
  MyAnimeList, and the titles of manga that steps 1 to 3 did not match. These
  requests share SeerrNG's AniList request budget;
- to the public API of [MangaDex](https://mangadex.org/), the UUIDs of
  unmatched library manga whose address in Suwayomi has the form
  `/manga/<UUID>`. SeerrNG sends only the UUID, never the address or the
  source. Matches made this way use data from MangaDex.

These lookups cannot be turned off yet, other than by turning off the Manga
category.

Each run sends at most 10 requests of each kind: MyAnimeList lookups (up to 50
IDs each), MangaDex lookups (up to 100 UUIDs each), and title searches (one
title each). With several Suwayomi servers, each server gets an equal part of
the requests left in the run, and a server that needs fewer leaves the rest to
the servers scanned after it; a MyAnimeList lookup that a server has started
can still read its last pages. The scan logs how many manga each server left
for a later run. A large library is therefore matched over several runs: with
the daily schedule, up to 10 manga get a title proposal each day. Run the job
by hand to speed this up. Manga that were never looked up go first, and a
finished lookup is repeated after 30 days. A lookup that fails or is rate
limited is retried on a later run, and the manga waits for its later steps
until then. When MangaDex rate limits or refuses requests, SeerrNG pauses
MangaDex lookups for up to an hour. MangaDex answers are cached for a day.

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
