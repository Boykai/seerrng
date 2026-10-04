---
title: Manga Backend
description: Enable manga discovery, choose which AniList titles SeerrNG shows, and request manga.
sidebar_position: 26
---

# Manga Backend

SeerrNG can show manga beside your other media. Manga discovery, search, and
details use metadata from [AniList](https://anilist.co/). Once a Suwayomi
server is [connected](#connect-suwayomi), users can also
[request manga](#request-manga). SeerrNG sends approved manga requests to the
Suwayomi server, which downloads the chapters; see [Dispatch](#dispatch).

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

SeerrNG downloads manga through a
[Suwayomi](https://github.com/Suwayomi/Suwayomi-Server) server. Connecting the
server lets users [request manga](#request-manga). SeerrNG sends each approved
request there, and Suwayomi downloads the chapters; see [Dispatch](#dispatch)
for what SeerrNG changes in Suwayomi.

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

The form also offers **Follow New Chapters**, which is **Off** by default; see
[Follow new chapters](#follow-new-chapters).

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
shows **Approved** again once the title is matched: by a library scan, on the
[Manga Library page](#manga-library-page), or by the **Manga Source Resolve**
job; see [Source resolution](#source-resolution). The job matches a title by
itself only when it finds an exact link; otherwise an administrator chooses a
source, as in [Resolve sources by hand](#resolve-sources-by-hand). Request
managers also see that an administrator may need to choose a source. For
administrators, **Choose Source** opens the title on the **Manga Sources**
page.

SeerrNG sends the request to Suwayomi once the title has a match it can use;
see [Which match a request uses](#which-match-a-request-uses). While the
request waits for a source, the API shows `awaitingBinding: true` in its
`mangaScope`.

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
  anything in Suwayomi by itself.
- Each decision updates the title's status right away, the same way a scan
  would.
- Each decision also updates the title's manga requests: they stop
  [waiting for a source](#waiting-for-a-source) once the title has a current
  match, and those whose chapters step 6 of [Dispatch](#dispatch) has not
  recorded yet wait again when it no longer has one. When a decision gives a
  title a match, SeerrNG sends the title's approved requests that were
  waiting; see [Dispatch](#dispatch).
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
Suwayomi by itself.

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
- When a title's match is rejected or its manga leaves the server, a request
  whose chapters step 6 of [Dispatch](#dispatch) has not recorded yet waits
  for a source again, and the next run searches the title. A request whose
  chapters step 6 has recorded keeps its match; see
  [Which match a request uses](#which-match-a-request-uses).
- Each run makes at most 60 Suwayomi searches per server, `id:` lookups
  included, three at a time, and stops each after 30 seconds. A source that
  fails or times out is skipped for that title. When Suwayomi cannot be
  reached, refuses the login, or no longer passes SeerrNG's checks, the run
  stops for that server.

### Resolve sources by hand

Administrators match requested titles under **Settings → Manga Sources**.
Like the [Manga Library page](#manga-library-page), it appears while the
Manga category is on and a Suwayomi server is configured. The page lists the
titles that wait for a source with their status from
[Statuses and retries](#statuses-and-retries), a short reason, and their
**Last Check** and **Next Check** times; filter the list by **Status**. A
title whose details SeerrNG cannot show, for example because the **Manga
Content** switches hide it, appears only as its AniList ID.

- **Search Now** asks the job to search the title next and resets its wait.
  The title shows **Search Queued** until the search has run. For a title
  whose request is still pending, the page asks you to confirm first, because
  the search sends the title to MangaDex and to the selected sources even
  though the request is not approved.
- **Open** shows the title's status with a link to its request, its matches
  on the server under **Library Matches**, and its **Suggestions**, exact
  links first. Each suggestion shows its title, the name and language of its
  source as plain text, its ranking (**High Confidence**, **Medium
  Confidence**, or **Weak Guess**) or **Matched with data from MangaDex** for
  an exact link, and **In Suwayomi Library** when the manga is already there.
  The page never shows a manga's address in Suwayomi.
- **Match** matches the title to a suggestion after you confirm. When the
  title already has a match, the confirmation says that this adds a second
  one.
- **Match by Hand** matches the title to a manga that Suwayomi already knows:
  enter its **Suwayomi Manga ID**, or choose one of the sources selected for
  the server and enter the manga's **Source-Relative URL**.

After a match, the page closes the title's details and the title leaves the
list. If an action fails, the page says why; when the title changed in the
meantime, refresh it and try again. Administrators can also open a title that
is [waiting for a source](#waiting-for-a-source) from its request with
**Choose Source**.

For automation, use the API under `/api/v1/manga/resolve`. The routes require
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
- A match makes the title's requests stop waiting for a source right away,
  and SeerrNG sends the approved ones; see [Dispatch](#dispatch). A pending
  request stays pending.

Matches made here or by the job also appear on the **Manga Library** page
under **Library Matches**, with the status **Active** while the manga is not
in the Suwayomi library. Reject a match there to undo it: the title's
requests whose chapters step 6 of [Dispatch](#dispatch) has not recorded yet
wait for a source again, and the job never matches that manga to the title by
itself again. A request whose chapters step 6 has recorded keeps its match;
see [Which match a request uses](#which-match-a-request-uses).

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
  job makes in Suwayomi. Once a title is matched, [Dispatch](#dispatch) sends
  its approved requests.

The job sends these requests only for requested titles. It logs counts, IDs,
and codes, never titles, search text, or addresses. The request and response
schemas and every error code are in the [REST API reference](../../seerr-api.yml).

## Dispatch

SeerrNG sends each approved manga request to the Suwayomi server it was made
for, in seven steps. Each step checks Suwayomi before it writes and is recorded
once it is done, so after a restart or an error SeerrNG continues with the step
where it stopped:

1. **Find the manga:** SeerrNG picks a current match of the title on that
   server and looks the manga up in Suwayomi; see
   [Which match a request uses](#which-match-a-request-uses).
2. **Check the server:** SeerrNG checks the server's marker; see
   [Server marker](#server-marker).
3. **Add to the library:** SeerrNG adds the manga to the Suwayomi library if it
   is not there yet.
4. **Add to the category:** SeerrNG adds the manga to the **SeerrNG** category
   and notes the request on the manga.
5. **Refresh the chapters:** SeerrNG asks the manga's source for its current
   chapter list. It does not refresh the manga's own details.
6. **Choose the chapters:** SeerrNG records the chapters the request gets; see
   [Which chapters a request gets](#which-chapters-a-request-gets).
7. **Queue the downloads:** SeerrNG queues each chosen chapter that Suwayomi
   has neither downloaded nor queued, 50 at a time. The title's status becomes
   processing, unless some or all of it is already available.

Steps 1 and 2 run again on every try. Suwayomi then downloads the chapters with
its own settings, and the library scan sets the title's status from what it
downloaded; see [Availability](#availability).

### What SeerrNG writes to Suwayomi

- **Library entries:** SeerrNG adds a requested manga to the library when it is
  not there yet, and records that it added it. A manga that was already in the
  library when a request first needed it counts as yours for good.
- **The SeerrNG category:** every requested manga joins one category named
  **SeerrNG**. SeerrNG creates it the first time, with Suwayomi's default
  settings, and creates it again if it is renamed or deleted.
- **Request notes:** `seerrng.request` in each manga's meta lists the requests
  for it, and one `seerrng.request.<request ID>` entry per request in the
  global meta names the manga that request went to. They mirror SeerrNG's own
  records, which decide everything; SeerrNG never acts on what the notes say.
- **Server marker:** `seerrng.instance` in the global meta; see
  [Server marker](#server-marker).
- **Chapter downloads:** SeerrNG adds chapters to Suwayomi's download queue and
  records each chapter it queued. It takes them off the queue again once no
  approved request needs them; see [When a request ends](#when-a-request-ends).

SeerrNG never:

- deletes downloaded chapters or any other file;
- takes a chapter that it did not queue off the download queue;
- removes a manga from the library or from a category;
- changes Suwayomi's settings;
- installs, updates, or removes extensions;
- links trackers;
- starts Suwayomi's downloader. Current Suwayomi releases start it themselves
  when chapters are queued.

### Which match a request uses

When the title has several current matches on the server, SeerrNG tries them
in this order: a manga that is already in the Suwayomi library, then a match an
administrator made, then the oldest match. It looks up at most five matches per
try and uses the first manga that Suwayomi still has.

A match counts when it came from tracking records or links (see
[Matching](#matching)), including the exact links that the **Manga Source
Resolve** job finds, or when an administrator confirmed or chose it. SeerrNG
never uses an automatic match ranked Medium or Low; a title with only such
matches waits, trying again every hour, until an administrator makes or
confirms a match for it (`MANGA_BINDING_UNCONFIRMED`).

Until step 6 has recorded the request's chapters, which it does once a chapter
fits the request, SeerrNG picks the match again on every try. When its choice
changes, for example because an administrator rejected the match the request
used, the request starts over with the new match; with no match left, it waits
for one. When the title still has current matches but Suwayomi has none of
their manga, the request starts over and tries again every hour
(`MANGA_BINDING_MISSING`), until Suwayomi has one of them again or no match is
left. Once step 6 has recorded the chapters, the request keeps its match. If
that match is rejected or stops being current, for example because its manga
left the Suwayomi library, the request tries again every hour until the match
is current again (`MANGA_BINDING_MISSING`). Once the chapters are queued,
rejecting the match leaves them queued, but until the match is current again,
an approved request shows `MANGA_BINDING_ORPHANED` and does not complete; see
[Requests that need attention](#requests-that-need-attention).
[Following new chapters](#when-following-stops-or-pauses) pauses until the
match is current again.

### Which chapters a request gets

A request asks for one of these scopes, which SeerrNG applies in step 6:

- every chapter the source lists at that moment, the default;
- the latest chapters, counted by chapter number;
- a range of chapter numbers, including both ends, or open at the end.

When the source lists a chapter number more than once, for example from several
scanlators, SeerrNG takes one version: the one from the scanlator that comes
first among the server's preferred scanlators (see
[Connect Suwayomi](#connect-suwayomi)), then the most recent upload. Chapters
without a number count only for the default scope. Chapters that Suwayomi has
already downloaded count toward the request but are not queued again. The
choice is final: chapters that the source adds later are not part of the
request, unless its requester [follows new chapters](#follow-new-chapters).
When no chapter matches the scope yet, SeerrNG tries again a day later
(`MANGA_NO_MATCHING_CHAPTERS`).

### Server marker

Before SeerrNG writes to a Suwayomi server, step 2 compares the marker
`seerrng.instance` in Suwayomi's global meta with the marker SeerrNG keeps for
that server entry:

- When the server has no marker, SeerrNG stores the entry's marker there. An
  entry gets a random marker the first time.
- When the server carries the marker of a server entry you removed from
  SeerrNG, and this entry has no marker yet, for example because you removed
  the server and added it again, this entry takes that marker over.
- Any other marker means that the server belongs to another SeerrNG server
  entry or installation, for example because you pointed the entry at a
  different Suwayomi server. SeerrNG writes nothing to it, does not take its
  word that a matched manga is gone, and tries again every 6 hours
  (`MANGA_INSTANCE_MISMATCH`).

When you point a server entry at a different Suwayomi server, requests that
SeerrNG already sent stay on the old server. Requests that are still being
sent continue on the new server from the step where they stopped: SeerrNG finds
the manga and checks the marker again, but does not repeat finished steps such
as adding the manga to the library. A new server without a marker gets the
entry's marker.

### When a request ends

When a request is no longer approved, because it was declined, deleted,
completed, or marked Failed, SeerrNG sends nothing more for it. Each run of the
**Manga Dispatch Sweep** then hands back on Suwayomi what such requests no
longer need:

- It takes off the download queue the chapters that SeerrNG queued for them
  and that are still queued, unless another approved request on the same
  server includes them. This also applies to a request that completes while
  some of its chapters are still queued.
- It deletes each such request's `seerrng.request.<request ID>` entry and
  rewrites the manga's `seerrng.request` from SeerrNG's records.

Downloaded chapters, library entries, and the **SeerrNG** category and its
manga stay. Retrying a failed request queues its chapters again.

While the server carries another marker or none, SeerrNG changes nothing on it
and its chapters stay queued. When Suwayomi cannot be reached or reports an
error, SeerrNG logs `Manga dispatch release will retry` under the **Manga
Dispatch** label with the server entry's ID, and tries again at the next run.
When you remove a server entry, SeerrNG forgets the chapters it queued there
without contacting that server. It also forgets the chapters of a manga that
Suwayomi no longer has, and those of a manga whose library record it lacks,
which it logs as `MANGA_RELEASE_UNRESOLVED` with their count.

### Dispatch sweep and retries

SeerrNG sends a request as soon as it is approved, and as soon as a waiting
request's title gets a match. The **Manga Dispatch Sweep** job runs every 5
minutes and sends up to 50 due requests per run: requests whose wait is over,
and approved requests that were never sent, such as those approved before
SeerrNG could send manga requests. Each run also hands back what ended requests
no longer need; see [When a request ends](#when-a-request-ends). Change its
schedule or run it now under **Settings → Jobs & Cache**. While the Manga
category is off, SeerrNG sends and hands back nothing; the sweep picks the
requests up again once you turn it back on.

When a step fails, SeerrNG either retries with a growing delay, starting at a
minute and doubling up to 6 hours, or waits a fixed time and lets the sweep try
again. After 50 failed tries in a row, about 10 days, SeerrNG marks the request
Failed. Retrying a failed request runs its steps again without repeating
finished work in Suwayomi, and the request keeps the chapters chosen for it.

SeerrNG logs each wait and retry under the **Manga Dispatch** label with the
request ID and one of these codes; the codes appear only in the logs. Log
entries contain IDs, counts, and codes only, never titles or addresses.

| Code | Reason | What SeerrNG does |
| --- | --- | --- |
| `MANGA_BINDING_MISSING` | The title has no current match on the server, or Suwayomi no longer has the matched manga. | With no current match, waits for one. When Suwayomi has none of the matched manga, or once step 6 has recorded the request's chapters, tries again every hour. When the manga disappears in the middle of a step, retries with a growing delay. |
| `MANGA_BINDING_UNCONFIRMED` | The title's only matches are automatic ones ranked Medium or Low. | Tries again every hour. |
| `MANGA_INSTANCE_MISSING` | The request's Suwayomi server is no longer configured, or its settings are incomplete. | Tries again every 6 hours. |
| `MANGA_INSTANCE_MISMATCH` | The server carries another marker; see [Server marker](#server-marker). | Writes nothing and tries again every 6 hours. |
| `MANGA_INSTANCE_CHANGED` | The server's address or login changed while the request was being sent. | Retries with a growing delay. |
| `MANGA_SUWAYOMI_UNAVAILABLE` | Suwayomi could not be reached, did not answer in time, or reported an error. | Retries with a growing delay. |
| `MANGA_SUWAYOMI_AUTH` | Suwayomi did not accept SeerrNG's login. | Tries again every 6 hours. |
| `MANGA_SUWAYOMI_UNSUPPORTED` | The Suwayomi server lacks a feature SeerrNG needs. | Tries again every 6 hours. |
| `MANGA_SUWAYOMI_ERROR` | A Suwayomi call failed in a way that an early retry does not fix, for example with an answer SeerrNG cannot use. | Tries again every 6 hours. |
| `MANGA_SOURCE_FETCH_FAILED` | The manga's source could not list its chapters. | Retries with a growing delay. |
| `MANGA_SOURCE_UNAVAILABLE` | The chapter list failed five times in a row. | Tries again every 6 hours. |
| `MANGA_NO_MATCHING_CHAPTERS` | No chapter matches the request's scope yet. | Tries again a day later. |
| `MANGA_DISPATCH_ERROR` | An unexpected error. | Retries with a growing delay. |

When Suwayomi no longer lists some of the chosen chapters in step 7, SeerrNG
queues the others and logs how many it skipped as `MANGA_CHAPTERS_UNMAPPED`.

## Follow new chapters

A request gets the chapters chosen for it when SeerrNG sends it; see
[Which chapters a request gets](#which-chapters-a-request-gets). When its
requester sets **Follow New Chapters** to **On**, SeerrNG also adds the
chapters that the source lists later and that fit the request's scope, and
queues them for download. Following is off for every request until its
requester turns it on.

### Turn following on or off

**Follow New Chapters** appears in the request form, below the chapter choice,
and is sent with the request. Later, it appears on the request's card on the
**Requests** page and in the request's window, which **View Request** on the
title's details page opens. There, a change applies at once, apart from
saving a pending request's chapters.

Only the requester can turn following on, while the request waits for
approval, is approved, or is complete, and only while they may request manga.
Nobody can turn it on for another user, neither when requesting for them nor
when editing their request. The requester or a user with the **Manage
Requests** permission can turn it off. On another user's request, a request
manager sees the choice only while following is on, with **Off** as its only
option. Turning it off stops further additions; the chapters already added
stay part of the request and download like the others. Through the
[REST API](../../seerr-api.yml), a new manga request turns following on with
`mangaFollow: true`.

Turning following on makes the request due at once. A request that is not sent
yet is checked once its chapters are queued.

### Manga Follow job

The **Manga Follow** job runs at minutes 7 and 37 of every hour. Each run first
turns following off for up to 100 declined or failed requests. It then checks
due requests that are approved or complete and whose chapters are queued,
those due longest first: up to 20 per Suwayomi server, and up to 5 per source
on that server. For each request, SeerrNG:

1. checks the server's marker; see [Server marker](#server-marker);
2. asks the manga's source for its current chapter list, without refreshing
   the manga's own details;
3. adds the new chapters that fit the request; see
   [Which new chapters a request gets](#which-new-chapters-a-request-gets);
4. queues each chapter that following added and that is not delivered yet,
   unless Suwayomi has already downloaded or queued it, 50 at a time, and
   records it as queued by SeerrNG.

Step 4 also queues a followed chapter again when it left the download queue
without being downloaded. Chapters that following queued are handed back like
the others when the request ends; see [When a request ends](#when-a-request-ends).
Following never changes the library, the **SeerrNG** category, the request
notes, the server marker, or Suwayomi's settings, and it does not need
Suwayomi's own automatic chapter downloads. The
[request notes](#what-seerrng-writes-to-suwayomi) can therefore leave out a
complete request that following opened again; SeerrNG never acts on them.

Change the job's schedule or run it now under **Settings → Jobs & Cache**.
While the Manga category is off, the job does nothing. When a server cannot be
reached, does not accept SeerrNG's login, carries another marker, or changes
while the job reads it, the run stops on that server and its requests stay due
for the next run. When one manga's chapter list fails or is not fresh, SeerrNG
checks that request again an hour later.

### Which new chapters a request gets

A check adds a chapter only when the source lists it with a chapter number that
no chapter of the request has yet, missing chapters included, and when that
number fits the request's scope:

| Scope | Chapters that following adds |
| --- | --- |
| Every chapter, the default | Every chapter with a new number. |
| The latest chapters | Chapters numbered above the highest number in the request. |
| A range of chapter numbers | Chapters numbered inside the range; when the range is open at the end, every chapter from its start on. |

Chapters without a number are never added, and neither is another version of
a number that the request already has, for example from another scanlator.
When the source lists a new number more than once, SeerrNG takes one version,
as described in [Which chapters a request gets](#which-chapters-a-request-gets).
A check adds at most 100 chapters and checks again an hour later for the rest.
One request holds at most 10,000 chapters.

### When SeerrNG checks again

After each check, SeerrNG schedules the next one from the manga's publication
status on AniList, or from the status that the source reports when AniList has
none:

| Status | Next check |
| --- | --- |
| Releasing, not yet released, or unknown | 8 hours later. |
| On hiatus | 7 days later. |
| Finished or cancelled | 30 days later when the check added nothing and every chapter of the request is delivered; otherwise 8 hours later. |

Each wait gets up to 4 more hours at random, so that checks spread out.

### Complete requests

When a check adds chapters to a complete request, SeerrNG opens the request
again in the same step: the request goes back to approved, its history gets an
**Approved** entry for the new chapters, and it shows **Downloading** until
they are delivered. The **Manga Progress** job follows the new chapters like
the others. Once every chapter of the request is delivered, the request
completes again and SeerrNG sends the **Request Available** notification
again. New chapters use the request's approval: they need no new approval and
do not count against request quotas.

### When following stops or pauses

When following stops, SeerrNG turns it off; the requester can turn it on again
where the request allows it. When it pauses, following stays on, SeerrNG checks
again every day, and the pause ends at the first check that finds nothing
wrong. The request's card and its window show the reason, and SeerrNG logs
each stop and pause under the **Manga Follow** label with the request ID and
one of these codes:

| Code | Kind | When |
| --- | --- | --- |
| `REQUEST_DECLINED` | Stop | The request was declined. |
| `REQUEST_FAILED` | Stop | The request was marked Failed. |
| `OWNER_NOT_PERMITTED` | Stop | The requester may no longer request manga. |
| `RANGE_COMPLETE` | Stop | The request asks for a range with an end, the source lists a chapter at or past that end, and the request has every chapter of the range that the source lists. |
| `MANIFEST_LIMIT` | Stop | More chapters fit the request than the 10,000 it can hold. SeerrNG first adds chapters up to the limit. |
| `BINDING_INACTIVE` | Pause | The title has no current match on the request's server, for example because the match the request uses was rejected; see [Review matches](#review-matches). |
| `BINDING_CHANGED` | Pause | The title's current match on the server is a different manga from the one the request was sent to. |
| `INSTANCE_MISSING` | Pause | The request's Suwayomi server is no longer configured, or its settings are incomplete. |
| `MANGA_NOT_FOUND` | Pause | Suwayomi no longer has the manga the request was sent to. |

Under the same label, SeerrNG logs `MANGA_FOLLOW_CHAPTERS_UNMAPPED` with a
count when Suwayomi no longer lists some followed chapters, which it skips,
`MANGA_FOLLOW_LIST_STALE` when the source's chapter list is not fresh, and
`MANGA_FOLLOW_INSTANCE_MISMATCH` when a server carries another marker. These
log entries contain IDs, counts, and codes only, never titles or addresses.

## Progress and availability

Once a request's chapters are queued, SeerrNG follows their downloads until
every chapter chosen for the request is delivered. It then marks the request
**Available** and sends the **Request Available** notification once.

### Manga Progress job

The **Manga Progress** job runs every 2 minutes. Each run looks at up to 200
approved requests whose chapters are queued, least recently checked first, so
every request gets its turn. For each Suwayomi server, it:

- reads the download state and the download queue of those requests' manga in
  batches;
- reads a manga's chapter lists only when its downloads, its queue entries, or
  its chapter list changed since the last run, or when a chapter waits for a
  file check;
- checks at most 50 chapter files, least recently checked first, and leaves
  the rest for the next run;
- updates the title's **Available** or **Partially Available** status the same
  way the library scan does; see [Availability](#availability).

Change the job's schedule or run it now under **Settings → Jobs & Cache**.
While the Manga category is off, the job does nothing. When a server cannot be
reached, does not accept SeerrNG's login, or changes while the job reads it,
the run stops on that server and the next run tries again.

The job only reads from Suwayomi. It never asks a source for chapters, and it
never queues, takes off the queue, downloads again, or deletes anything. Once
a request's chapters are queued, nothing in SeerrNG queues them again on its
own; only a [retry](#retry-chapters) does, apart from the chapters that
[following](#follow-new-chapters) added.

### Delivered chapters

A chapter counts as delivered once Suwayomi lists it as downloaded and SeerrNG
has checked its file. SeerrNG asks Suwayomi for the chapter's CBZ file with an
HTTP `HEAD` request, which transfers no file, and the answer must report a size
above zero. A chapter whose file is empty or missing, or whose size Suwayomi
does not report, is not delivered, whatever Suwayomi's download records say.
SeerrNG does not use Suwayomi's per-user download state; the file check alone
decides.

A delivered chapter stays delivered unless its file goes away. SeerrNG checks
the file again when Suwayomi stops listing the chapter as downloaded, at most
every 30 minutes, and counts the chapter as not delivered once the file is
gone. After a request is complete, SeerrNG no longer checks its chapters.

When a source changes a chapter's address, SeerrNG follows the change if
exactly one chapter that the source lists now has the same number and
scanlator; the chapter at its new address needs its own file check. Otherwise
the chapter counts as missing and is no longer delivered.

### Request and title status

A request's progress and the title's status answer different questions:

- The title's **Available** or **Partially Available** status covers every
  chapter that Suwayomi lists for the matched manga, from Suwayomi's download
  records; see [Availability](#availability).
- A request is complete once every chapter chosen for it is delivered.

So a request can be complete while the title shows **Partially Available**:
a request for the latest chapters or for a range of chapter numbers covers
only part of what Suwayomi lists. The reverse also happens. The title can show
**Available** while a request is still downloading, for example when another
scanlator's version of a chapter is downloaded, or when Suwayomi lists a
chapter as downloaded but its file is gone. Completing a request never changes
the title's status.

### Request stages

A manga request's status shows one of these stages:

| Stage | When |
| --- | --- |
| Requested | The request waits for approval. |
| Approved | The request waits to be sent, or waits for a match; see [Waiting for a match](#waiting-for-a-match). |
| Searching | SeerrNG found the manga and works through steps 2 to 7 of [Dispatch](#dispatch). |
| Downloading | The chapters are queued. The progress is the share of the request's chapters that are delivered. Chapters in Suwayomi's download queue show as downloads such as **Chapter 12**, with their progress. |
| Available | Every chapter of the request is delivered, and no [code](#requests-that-need-attention) holds the request back. |
| Failed | Some chapters failed to download or are not queued, or SeerrNG stopped sending the request after 50 failed tries; see [Dispatch sweep and retries](#dispatch-sweep-and-retries). |
| Declined | The request was declined. |

When a request needs an administrator, its status explains what happened,
whether SeerrNG tries again by itself, and what to do. Status messages never
name a source, an extension, or an address. Reading a request's status never
contacts Suwayomi.

### Requests that need attention

The Manga Progress job records at most one of these codes per request; when
several apply, it records the first in the table. A code clears by itself once
its cause is gone, and it never fails, completes, or sends a request again.
While a request has a code, it does not complete. SeerrNG logs each code when
it is raised and when it clears, under the **Manga Progress** label, or under
**Manga Retry** when a retry clears it. These log entries contain IDs, counts,
and codes only, never titles or addresses.

| Code | What happened | What to do |
| --- | --- | --- |
| `MANGA_INSTANCE_REMOVED` | The request's Suwayomi server was removed from SeerrNG. SeerrNG stops checking the request. | Delete the request so the title can be requested again. |
| `MANGA_BINDING_ORPHANED` | Suwayomi no longer has the manga the request was sent to, or the title's match on that manga was rejected or is no longer current. When the only change is that the manga left the library, the request shows `MANGA_NOT_IN_LIBRARY` instead, even after the library scan marks the match as no longer current. | Review the match under **Settings → Manga Library**. |
| `MANGA_NOT_IN_LIBRARY` | The manga left the Suwayomi library. | Add the manga to the library again in Suwayomi. |
| `MANGA_CHAPTER_ERROR` | Suwayomi could not download some of the chapters. They stay in its download queue with an error. | Check Suwayomi's download queue and logs, fix the cause, then [retry](#retry-chapters) the request. |
| `MANGA_CHAPTER_FILE_MISSING` | Suwayomi lists some chapters as downloaded, but their files were empty or missing in two checks. | Delete those chapters' downloads in Suwayomi. Once the request reports `MANGA_CHAPTER_NOT_QUEUED`, retry it. |
| `MANGA_CHAPTER_LENGTH_UNKNOWN` | Suwayomi sent no file size for some downloaded chapters, so SeerrNG cannot confirm them. | Check whether a proxy in front of Suwayomi removes the `Content-Length` header. |
| `MANGA_CHAPTER_MISSING` | For a day, the source has not listed some of the chapters, and no other chapter replaces them; see [Delivered chapters](#delivered-chapters). | Check the manga's source in Suwayomi. If the chapters do not come back, delete the request and request the title again. |
| `MANGA_CHAPTER_NOT_QUEUED` | Some chapters were neither downloaded nor queued in two checks in a row, for example because they were taken off the queue, or because their address changed before SeerrNG queued them. | [Retry](#retry-chapters) the request. |

Of these codes, only `MANGA_CHAPTER_ERROR` and `MANGA_CHAPTER_NOT_QUEUED` make
a request show **Failed**, which the **Needs Attention** filter on the
**Requests** page counts. A request with any other code keeps its stage,
usually **Downloading**, so that filter does not count it; its status still
explains the code.

### Retry chapters

When a request shows **Failed** because of `MANGA_CHAPTER_ERROR` or
`MANGA_CHAPTER_NOT_QUEUED`, a user with the **Manage Requests** permission can
retry it with **Retry** on the **Requests** page, or through the
[REST API](../../seerr-api.yml). The retry queues each of the request's
chapters that has an error in Suwayomi's queue or is neither downloaded nor
queued, 50 at a time, and records them as queued by SeerrNG. An errored
chapter gets one more download attempt.

The request stays approved and keeps its match and its chosen chapters. The
retry does not ask the source for chapters again, takes nothing off the queue,
and deletes nothing. It is refused while a code higher in the table comes
first. When Suwayomi cannot be reached or the server changes during the retry,
the retry fails; try again later. Without the **Manage Requests** permission,
the requester cannot retry a request in this state.

### Report an issue

Users with the **Create Issues** or **Manage Issues** permission can report a
problem with an **Available** or **Partially Available** manga with **Report an
Issue** on its details page. Manga reports use the **Other** issue type. While
the Manga category is on, the **Issues** page has a **Manga** filter.

## Download copy

A manga request offers each chapter that SeerrNG has verified as a **Download
copy** on its [Request Status](./request-status.md#download-an-available-copy)
card: while the rest of the request is still downloading, after the request
failed, and once it is available. Each chapter downloads as one CBZ file named
after the manga's AniList title, English first, then romaji, then native, for
example `Title - Ch. 12.5.cbz`. When SeerrNG cannot show a title, the name
uses `Manga` and the AniList ID instead. A chapter without a number is named
`Ch. unknown`, and repeated names get ` (2)`, ` (3)`, and so on. The list shows
up to 1,000 chapters, newest first. There is no **Download all**.

The user who made the request can download its chapters, and so can users with
the **Manage Requests** or **View Requests** permission. SeerrNG checks access
and the request's stage again before every download.

The list holds only the request's own chapters that SeerrNG verified in
Suwayomi and has not since found missing. Listing never contacts Suwayomi. The
list stays empty unless all of these hold:

- the Manga category is on;
- the request's title has a match on the request's Suwayomi server, and that
  match is still active;
- that server is still configured, with **Require CBZ Downloads** on. While it
  is off, SeerrNG lists no chapters, because Suwayomi may have saved them as
  folders of images.

When a download starts, SeerrNG looks the manga up in Suwayomi by its source
and address, checks that it is still the matched manga, finds the downloaded
chapter, and passes Suwayomi's CBZ archive to the browser as it arrives.
SeerrNG stores nothing on its own disk and never marks a chapter read.

Limits:

- **Concurrent downloads:** each user can run 2 chapter downloads at a time,
  and each Suwayomi server 4. Beyond that, SeerrNG answers
  `429 Too Many Requests` with `Retry-After: 30` before it contacts Suwayomi.
- **Size:** SeerrNG sends at most 1 GiB per chapter, a fixed limit built into
  its Suwayomi connection. A larger chapter is refused with a message saying
  that it is larger than the download size limit or, when Suwayomi does not
  give its size in advance, stopped at the limit.
- **Time:** SeerrNG stops a download when the browser accepts no data for 2
  minutes, when Suwayomi sends nothing for 45 seconds while the browser waits
  for data, or when the download has run for 30 minutes.
- **Whole files only:** SeerrNG ignores byte-range requests and sends the whole
  archive, so an interrupted download starts again from the beginning.

When Suwayomi no longer has the manga or the downloaded chapter, the download
answers `404`. When Suwayomi cannot be reached or reports an error, the
download answers `502` with a fixed message, and SeerrNG logs
`Unable to open a manga download copy` under the **Request Downloads** label. A
download that Suwayomi or one of these limits stops partway is logged as
`Stopped a manga download copy`; a browser that leaves is not logged. When the
chapters cannot be listed, the list is empty and SeerrNG logs
`Unable to list manga download copies`. These log entries contain IDs and codes
only, never titles or addresses.
