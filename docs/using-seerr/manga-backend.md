---
title: Manga Backend
description: Enable manga discovery, choose which AniList titles SeerrNG shows, and request manga.
sidebar_position: 26
---

# Manga Backend

SeerrNG can show manga beside your other media. Manga discovery, search, and
details use metadata from [AniList](https://anilist.co/). Once a Suwayomi
server is [connected](#connect-suwayomi), users can also
[request manga](#request-manga). SeerrNG records approved manga requests but
does not send them to Suwayomi yet; downloading through Suwayomi arrives in a
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
server lets users [request manga](#request-manga); SeerrNG does not send those
requests to Suwayomi yet.

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

## Request manga

Users can request manga while the Manga category is on and a Suwayomi server
is connected. Without a connected server, manga cards and details pages show
no **Request** button, and the API refuses manga requests with HTTP `400` and
the message "No Suwayomi server is configured for manga requests." Each title
can have one pending or approved request at a time. Available and blocklisted
titles show no **Request** button. A title that already has a pending or
approved request shows its request status on the details page instead, and the
request form shows it as **Requested**. Manga has no 4K requests.

Select **Request** on a manga card or details page and choose which chapters
to request:

- **All chapters**, the default: every chapter that is available when SeerrNG
  sends the request to Suwayomi.
- **Latest chapters**: the newest chapters, from 1 to 10,000 of them.
- **Chapter range**: the chapters from a starting number, with an optional
  last chapter. Leave the last chapter empty to request every chapter from the
  starting number onward. Chapter numbers go from 0 to 1,000,000 and may have
  decimals, such as 10.5.

SeerrNG chooses the chapters when it sends the request to Suwayomi, not when
the request is made. Request cards, request lists, and the **Requests** page
show the choice in a **Chapters** row, for example "All", "Latest 25", "10–20",
or "10 onward".

### Permissions and quotas

Administrators can grant **Request Manga** and **Auto-Approve Manga** in user
permissions; **Request** and **Auto-Approve** also cover manga. Requests from
users without an auto-approve permission wait for a request manager's
approval. **Global Manga Request Limit** in **Settings > Users** sets a manga
request limit for everyone. To give one user a different limit, enable
**Override Global Limit** under **Manga Request Limit** in that user's
**General** profile settings. Users see their current usage in the request
form and on their profile.

### Change a pending request

While a manga request is pending, select **View Request** on the title's
details page, or edit the request from its request card, to change the chapter
choice. Requesters with the **Advanced Requests** permission can change their
own requests, and users with **Manage Requests** can change any request. The
requester and users with **Manage Requests** can also cancel a pending request
there.

### Waiting for a source

An approved request shows **Waiting for a source** instead of **Approved**
while its title has no current match on the Suwayomi server, so SeerrNG does
not know yet which manga in Suwayomi it belongs to; see [Matching](#matching).
The request stays approved, and the requester does not need to do anything. It
shows **Approved** again once the title is matched, for example by a library
scan or on the [Manga Library page](#manga-library-page). Request managers also
see that an administrator must link a source first.

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
  change afterwards. Only an administrator's review changes it.
- SeerrNG keeps unmatched manga and their proposals for an administrator to
  review; see [Review matches](#review-matches). An unmatched manga never
  makes a title available.

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

### Review matches

Administrators review matches on the **Manga Library** settings page (see
[Manga Library page](#manga-library-page)) or through the API. The routes are
under `/api/v1/manga/library` and require administrator permission. While the
Manga category is off, they return the normal not-found response.

| Method and route | Purpose |
| --- | --- |
| `GET /candidates` | List unmatched manga and their proposals, 20 per page by default. Filter by Suwayomi instance or by proposal ranking: `HIGH`, `MEDIUM`, `LOW`, or `NONE` for manga without a proposal. |
| `GET /bindings` | List matches, including rejected ones. Filter by Suwayomi instance, AniList ID, or state. |
| `POST /candidates/{candidateId}/confirm` | Accept the proposal of an unmatched manga. |
| `POST /bind` | Match a manga to an AniList title by hand. Name the manga by its Suwayomi ID, or by its source ID and its address in Suwayomi. |
| `POST /reject` | Reject an AniList title for a manga. |

- SeerrNG never confirms a proposal by itself, whatever its ranking.
- A manual match replaces the manga's current match, and the replaced title
  then counts as rejected for that manga.
- A rejected title is never proposed or matched for that manga again; only a
  manual match can restore it. Rejecting a manga's current match returns the
  manga to the unmatched list. Rejecting its proposal lets the next scan
  propose a different title.
- Before a confirmation or a manual match, SeerrNG reads the manga from
  Suwayomi to check that it is still in the library and how much of it is
  downloaded. A rejection reads nothing from Suwayomi. No decision changes
  anything in Suwayomi.
- Each decision updates the title's status right away, the same way a scan
  would.
- Each decision also updates the title's manga requests: they stop
  [waiting for a source](#waiting-for-a-source) once the title has a current
  match, and wait again when it no longer has one.
- When the Suwayomi read fails, the decision returns HTTP `502` and changes
  nothing. When it conflicts with a change made meanwhile, for example by a
  scan, it returns HTTP `409`; reload the manga and decide again.

Each match records how it was made in `matchedBy`: `anilist-tracker`,
`mal-tracker`, `mangadex-link`, `title` (a confirmed proposal), or `manual`. A
`mangadex-link` match uses data from [MangaDex](https://mangadex.org/); credit
MangaDex wherever you show it. Decisions are logged with IDs only, never
titles or addresses. The request and response schemas and every error code
are in the [REST API reference](../../seerr-api.yml).

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

## Manga Library page

Administrators review library matches under **Settings → Manga Library**. The
page appears while the Manga category is on and a Suwayomi server is
configured. Its decisions follow the rules in
[Review matches](#review-matches), and none of them changes anything in
Suwayomi.

Library titles come from your Suwayomi server and appear as plain text. The
page never shows a manga's address in Suwayomi. An AniList title that the
**Manga Content** switches hide appears only as its AniList ID.

### Review queue

The **Review Queue** lists the manga in your Suwayomi library that have no
AniList match yet, with the title SeerrNG proposes for each:

- **High Confidence**, **Medium Confidence**, and **Weak Guess** are the High,
  Medium, and Low rankings described in [Matching](#matching). They rank a
  proposal only: nothing is matched until an administrator confirms a proposal
  or chooses a title. No proposal is preselected, and there is no way to
  confirm proposals in bulk.
- **No Proposal** means the manga has no proposal right now, for example
  because no scan has searched its title yet or its last proposal was
  rejected.

For each manga, you can:

- **Confirm** the proposal. SeerrNG first checks the manga in Suwayomi, so
  this can take a moment.
- **Choose Title** to search the AniList catalog and pick the matching title.
  The title always comes from the search results; there is no field for typing
  an AniList ID.
- **Reject** the proposal, with a second click to make sure. SeerrNG never
  proposes that title for the manga again.

Filter the queue by **Confidence** to work through one ranking at a time. If a
decision fails, the page says why and nothing changes; for example, when a
scan replaced the proposal in the meantime, check the new proposal and try
again.

Proposals arrive with each library scan, so a large library gets them over
several runs; see [Lookups on AniList and MangaDex](#lookups-on-anilist-and-mangadex).
While the queue is empty or lists manga without a proposal, the page suggests
running the **Manga Library Scan** job under **Settings → Jobs & Cache** to
get proposals sooner.

### Library matches

**Library Matches** lists the matched manga. Filter it by **Status**:
**Active** (the default), **Not in Library** for manga that left the Suwayomi
library or whose server was removed, **Rejected**, or all. The **Match**
column says how each match was made:

- **AniList Tracker Link** or **MyAnimeList Tracker Link**: from the manga's
  tracking records in Suwayomi.
- **Matched with data from MangaDex**: from the AniList link that MangaDex
  lists for the manga. SeerrNG credits [MangaDex](https://mangadex.org/) in
  this text wherever it shows such a match.
- **Confirmed by an Admin**: an administrator confirmed a proposal; the badge
  shows how the proposal was ranked.
- **Chosen by an Admin**: an administrator chose the title.

The **Status** column shows **Available**, **Partially Available**, or **In
Suwayomi Library** for a current match, depending on how many of its chapters
are downloaded; **Not in Library** for a manga that left the Suwayomi library
or whose server was removed; and **Rejected** for a match that an
administrator rejected or replaced.

- **Choose Title** matches the manga to the title you pick and replaces its
  current match. On a rejected entry, picking the same title again restores
  the match. Manga that are no longer in the library cannot be matched.
- **Reject** rejects the match. A manga that is still in the library returns
  to the review queue, and SeerrNG never proposes or matches that title for it
  again unless you choose it.

### Availability on manga pages

Once SeerrNG has matched a title to a manga in your Suwayomi library, the
title's details page shows an **Availability** row:

- **Available** or **Partially Available** from the chapters Suwayomi has
  downloaded; see [Availability](#availability).
- **In Suwayomi Library** while no chapter is downloaded yet.

The marker shows while a current match links the title to a manga in the
Suwayomi library. Rejecting the match clears it right away, and the next
library scan clears it once the manga has left the library or you removed the
Suwayomi server. Everyone who can open the details page sees the row, which
names no server, source, or address. Blocklisted titles show no availability
row.

### Recently Added

While the Manga category is on, the **Recently Added** row on Discover also
lists manga, newest first, from the moment they become Available or Partially
Available. A title that stopped being available moves to the front again when
it becomes available again. Titles that the **Manga Content** switches hide
are left out. The row now also appears when Manga is the only one of the
Movies, Series, and Manga categories that is on.

## Source resolution

To download a requested manga through Suwayomi, SeerrNG needs a match between
the AniList title and a manga in one of the sources you selected for
Suwayomi. The **Manga Source Resolve** job looks for these matches. It runs
every 10 minutes; change its schedule or run it now under **Settings → Jobs &
Cache**. It does nothing while the Manga category is off or no Suwayomi
server is configured.

The job only matches by itself when it finds an exact link through MangaDex.
Everything else waits for an administrator.

### What the job searches

Each run handles up to 20 requested titles that have no match on the
Suwayomi server yet. Titles that an administrator asked to search go first,
then the rest, oldest request first.

- The job searches titles of approved requests. A title whose request is
  still pending is searched only when an administrator asks for it; see
  [Resolve sources by hand](#resolve-sources-by-hand).
- Before each search, SeerrNG reads the title from AniList again and checks
  the **Manga Content** switches. A title that they hide is marked
  **Excluded** and is not searched; SeerrNG checks it again a day later. Its
  request stays as it is.
- A title that already has a match on the server is not searched again; its
  request is marked as matched.

### Exact links

1. SeerrNG searches the public catalog of [MangaDex](https://mangadex.org/)
   for the title's English, romaji, and native titles, at most three
   searches, and stops at the first search that finds a MangaDex entry
   listing the title's AniList ID.
2. When exactly one MangaDex entry lists it, Suwayomi looks that entry up by
   its MangaDex ID (an `id:` search) in the selected sources, at most five
   lookups per title. A result counts only when its address in Suwayomi has
   the form `/manga/<UUID>` with the same UUID. SeerrNG remembers which
   sources answered such a lookup and asks the others again at most once a
   week.
3. SeerrNG matches the title to the best result by itself: the source whose
   language comes first in your preferred languages, then the source selected
   first. When you set preferred languages, only a source in one of them, or
   a source that Suwayomi lists as `all` or `multi` languages, is matched by
   itself.

An exact result is only offered to an administrator, and is not matched by
itself, when:

- MangaDex lists two or more entries for the title;
- only a title search found it, not an `id:` lookup;
- its source's language is not one of your preferred languages;
- the manga is already in the Suwayomi library; the library scan or an
  administrator matches it instead;
- the manga is matched to a different AniList title;
- an administrator rejected the title for that manga.

These matches use data from MangaDex and record `matchedBy` as
`mangadex-link`; credit MangaDex wherever you show them.

### Title searches

Without an exact match, Suwayomi searches up to 20 selected sources, in the
order you selected them, with up to two of the title's names each. For a
source in the title's original language, the native title goes first.
SeerrNG keeps the closest result from each source, compared with the title's
romaji, English, native, and alternative titles, plus a bonus when the
source credits one of the title's story or art staff. Results are ranked
High, Medium, and Low as in [Matching](#matching); one-shots and novels are
never ranked High. Each title keeps at most 10 suggestions.

A title search never matches a title by itself, whatever its ranking: an
administrator picks one.

While **Include Adult Manga** is off, title searches go only to sources that
Suwayomi marks as safe, so a source with an unknown rating is not searched.
While it is on, they go to every selected source. `id:` lookups go to every
selected source either way, because a result must carry the MangaDex ID of a
title that the **Manga Content** switches allow.

### Statuses and retries

| Status | Meaning | Next search |
| --- | --- | --- |
| **Awaiting Approval** | Only pending requests wait, and no search that an administrator asked for is open. | When a request is approved or an administrator asks for a search. |
| **Queued** | Not searched yet, asked for by an administrator, or waiting for a source again after losing its match. | The next run, or within an hour after a search that failed. |
| **Needs Pick** | Suggestions wait for an administrator. | After 7 days, or after 1 hour when MangaDex or a source failed during the search. |
| **No Match** | No source returned a usable result. | After 1 hour, 6 hours, and 24 hours, then every 7 days. |
| **Excluded** | The **Manga Content** switches hide the title, or AniList no longer lists it. | After 24 hours. |
| **Bound** | The title has a match on the server. | None. |

- When MangaDex or a source fails, the job still uses the others, keeps the
  title's wait as it was, and searches the title again within an hour, so an
  outage never makes a title wait a week. While MangaDex or AniList rate
  limits requests, or when AniList fails, titles wait for a later run without
  a longer wait.
- A title that no selected source may search, because none of them is
  installed or **Include Adult Manga** leaves none, waits as **No Match**
  does.
- An administrator's search request resets the wait.
- When a title's match is rejected or its manga leaves the server, its
  request waits for a source again and the next run searches it.
- Each run makes at most 60 Suwayomi searches per server, `id:` lookups
  included, three at a time, and stops each after 30 seconds. A source that
  fails or times out is skipped for that title. When Suwayomi cannot be
  reached, refuses the login, or no longer passes SeerrNG's checks, the run
  stops for that server.

### Resolve sources by hand

A picker on the settings pages arrives in a later release. Until then,
administrators use the API under `/api/v1/manga/resolve`. The routes require
administrator permission; while the Manga category is off, they return the
normal not-found response.

| Method and route | Purpose |
| --- | --- |
| `GET /` | List titles that wait for a source, with their status, 20 per page by default. Filter by `status`: `QUEUED`, `NEEDS_PICK`, `NO_MATCH`, `EXCLUDED`, or `AWAITING_APPROVAL` for a pending request with no open search request. |
| `GET /{anilistId}?instanceId=` | Show a title's status, its suggestions, and its current matches on that Suwayomi server. |
| `POST /{anilistId}/search` | Search the title at the next run, or start a run now, with a fresh wait. This also searches a title whose request is still pending. |
| `POST /{anilistId}/select` | Match the title to one of its suggestions. |
| `POST /{anilistId}/bind` | Match the title to a manga that Suwayomi already knows. Name the manga by its Suwayomi ID, or by its source ID and its address in Suwayomi. |

- Before a match, SeerrNG reads the manga from Suwayomi. When Suwayomi no
  longer knows a suggestion, the match returns HTTP `409`. A manga that
  Suwayomi has never stored returns HTTP `404`; search for it first, in
  Suwayomi or with the search route, so that Suwayomi stores it.
- SeerrNG refuses Suwayomi's local source and sources that are not selected
  for the server with HTTP `400`. A manga that is matched to a different
  AniList title returns HTTP `409`.
- A manga that is already in the Suwayomi library gets a library match, as
  in [Review matches](#review-matches).
- Picking an exact suggestion for a manga outside the Suwayomi library keeps
  its MangaDex credit; every other match is recorded as `manual`.
- A match makes the title's requests stop waiting for a source right away. A
  pending request stays pending.

Matches made here or by the job also appear on the **Manga Library** page
under **Library Matches**, with the status **Active** while the manga is not
in the Suwayomi library. Reject a match there to undo it: the title's
requests wait for a source again, and the job never matches that manga to
the title by itself again.

### What leaves your server

- To AniList: the IDs of requested titles. These requests share SeerrNG's
  AniList request budget.
- To MangaDex's public API: the English, romaji, and native titles of
  requested titles. SeerrNG sends no address and no source. These requests
  share the pause rules of the library scan's MangaDex lookups, and the
  answers are cached for a day.
- Through Suwayomi: Suwayomi sends the `id:` lookups and title searches to
  the selected sources, and stores the manga it finds in its own database
  without adding them to its library. A source search is the only change the
  job makes in Suwayomi.

The job sends these requests only for requested titles. It logs counts, IDs,
and codes, never titles, search text, or addresses. The request and response
schemas and every error code are in the [REST API reference](../../seerr-api.yml).
