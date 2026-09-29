---
title: Comics Backend
description: Configure ComicVine, Mylar3, Kapowarr, and BackIssue for comic requests.
sidebar_position: 24
---

# Comics Backend

SeerrNG discovers comics through [ComicVine](https://comicvine.gamespot.com/)
and can send full-volume requests to [Mylar3](https://github.com/mylar3/mylar3),
[Kapowarr](https://github.com/Casvt/Kapowarr), or
[BackIssue](https://backissue.app/). You can configure more than one backend.
Users with advanced request permission can choose a configured server; other
requests go to the single default across all three backends. For Kapowarr,
advanced requesters can also select a root folder already configured there.

## ComicVine API Key

Comic discovery and requests require a free ComicVine API key, independent of
any ComicVine key configured inside Mylar3 or Kapowarr themselves.

1. Sign in or create an account at
   [comicvine.gamespot.com](https://comicvine.gamespot.com/).
2. Generate an API key from your ComicVine account settings.
3. In SeerrNG, open **Settings > General** and enter the key under **Comics
   Metadata > ComicVine API Key**.

Until this key is configured, the Comics Discover page returns no results,
`GET /api/v1/discover/comics` responds with an empty result set rather than an
error, and the Comics category in global Search has no catalog results.

With a key configured, global Search includes a **Comics** category backed by
ComicVine. Use the main search query to find volume titles; the category also
lets you narrow matches by title, aliases, publisher, or start year.

On the Comics Discover page, filter volumes by publisher, start year, and
minimum or maximum issue count. The first filtered search starts a resumable
ComicVine volume index in the background. The page shows indexing progress
until that first scan is complete; filtered counts and pages are shown only
afterward. SeerrNG keeps the last complete index available during periodic
refreshes. ComicVine limits how quickly the first scan can finish, so a large
catalog can take hours to index.

## Choosing a backend

| | Mylar3 | Kapowarr | BackIssue |
| --- | --- | --- | --- |
| API style | Legacy query-string (`?apikey=&cmd=`) | JSON REST | JSON REST |
| Acquisition | Usenet and torrent indexers | Direct-download sources | BackIssue's configured sources and download settings |
| Extra setup | None | Requires a companion FlareSolverr container | Configure BackIssue's own sources and auto-download behavior |
| Request model | Complete ComicVine volume | Complete ComicVine volume | Complete ComicVine volume |

Kapowarr's only indexer today,
GetComics.org, has a known, unresolved upstream bug where direct-from-site
downloads (as opposed to its mirror hosts such as MediaFire) frequently fail.
Mirror-host downloads are generally reliable; direct-site downloads are not.

## Full volumes and back issues

SeerrNG requests a complete ComicVine volume, not individual issue numbers.
Open a comic's detail page to browse its back issues, including cover art and
cover dates when ComicVine provides them. The issue list loads when you reach
it and continues in pages of 20 with **Load more issues**. Browsing an issue
does not submit an individual issue request.
The selected backend receives the complete volume and handles its searches and
downloads. SeerrNG does not override those service settings. In BackIssue,
configure its source and auto-download settings if adding a volume should start
an acquisition. Enable **Sync** on the SeerrNG service connection to scan its
collection and show owned or actively tracked issues in SeerrNG.

SeerrNG's **Indexer Search** page can query Prowlarr's configured comic
categories for manual inspection by users with **Manage Requests**. These
results are not grabbed or tracked; the selected comic backend handles approved
requests. Prowlarr can sync indexers to Mylar3, so confirm the providers are
enabled in Mylar3's search settings. BackIssue can use its own
[Prowlarr plugin](https://backissue.app/prowlarr) to feed its Usenet and torrent
sources. Prowlarr does not add indexers to Kapowarr, which uses its
direct-download sources. See [Indexer searches by media category](./indexer-searches.md).

Mylar3 and Kapowarr need their own, separately configured ComicVine API key for
their own internal search — this is unrelated to the SeerrNG-level key above,
and only affects features SeerrNG does not use (SeerrNG's own ComicVine client
handles discovery; the backends are only asked to add and track already-
identified comics).

## Mylar3 setup

1. Deploy Mylar3 (for example `lscr.io/linuxserver/mylar3`).
2. In SeerrNG, open **Settings > Services** and add a Mylar3 server.
3. Enter its hostname, port, and API key (**Mylar3 > Settings > General >
   Security**).
4. If Mylar3 should be the default comics destination, mark this instance as
   the default across all configured comic services.
5. Enable **Sync** to bring already-owned comics into SeerrNG as available.

## Kapowarr setup

Kapowarr requires a companion [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr)
container to get past Cloudflare on GetComics.org and its mirror hosts. This
is a real second-container deployment requirement, not optional polish:

```yaml
services:
  kapowarr:
    image: mrcas/kapowarr:latest
    ports:
      - '5656:5656'
    volumes:
      - ./kapowarr-db:/app/db
      - ./kapowarr-downloads:/app/temp_downloads

  flaresolverr:
    image: ghcr.io/flaresolverr/flaresolverr:latest
    ports:
      - '8191:8191'
```

Point Kapowarr's FlareSolverr setting at the `flaresolverr` container, then:

1. In SeerrNG, open **Settings > Services** and add a Kapowarr server.
2. Enter its hostname, port, and API key (**Kapowarr > Settings > General**).
3. Select a **Root Folder** — Kapowarr requires one; SeerrNG's connection test
   lists the root folders Kapowarr already knows about.
4. If Kapowarr should be the default comics destination, mark this instance as
   the default across all configured comic services.
5. Enable **Sync** to bring already-owned comics into SeerrNG as available.

## BackIssue setup

1. Install BackIssue using its [getting-started
   guide](https://backissue.app/getting-started), then create a personal API
   key for an account with `library.view`, `library.manage`, and
   `downloads.grab` permissions. Those permissions let SeerrNG scan the
   collection, add or remove a series, and read or cancel its download queue.
2. Configure BackIssue's own download sources and whether adding a series
   should start acquisition. SeerrNG sends the ComicVine volume to BackIssue;
   BackIssue controls the search and download behavior.
3. In SeerrNG, open **Settings → Services → BackIssue Settings** and select
   **Add BackIssue Server**.
4. Enter a recognizable server name, its address, port (8787 by default), and
   API key. Use **Test** to confirm SeerrNG can reach it, then choose whether
   it should be the default destination and whether SeerrNG should scan its
   collection.

## Manage BackIssue from the CLI or API

The Settings page is the normal way to connect BackIssue. Service management is
also available through the administrator API and a readable CLI for setup
scripts and server administrators. Both use a SeerrNG administrator API key;
the separate BackIssue key is sent in the configuration body, and the CLI
reads it from the environment rather than command arguments.

```bash
export SEERRNG_URL="https://seerr.example.com"
export SEERRNG_API_KEY="your-seerrng-admin-api-key"
export BACKISSUE_API_KEY="your-backissue-api-key"

pnpm backissue:service -- test --host backissue --port 8787
pnpm backissue:service -- add --name Home --host backissue --default --sync
pnpm backissue:service -- list
pnpm backissue:service -- update 1 --host backissue.example.com --https
pnpm backissue:service -- remove 1
pnpm backissue:service -- scan
```

The CLI also accepts `--base-url` and `--external-url`. Use `--no-default` or
`--no-sync` while updating a server to turn those settings off. The `scan`
command starts the BackIssue collection sync immediately and needs only the
SeerrNG administrator API key. The API exposes `GET` and `POST
/api/v1/settings/backissue`, `POST
/api/v1/settings/backissue/test`, and `PUT` or `DELETE
/api/v1/settings/backissue/{id}`, plus `POST
/api/v1/settings/jobs/backissue-scan/run` to start the same scan task. These
endpoints require administrator authentication.

## Configuration checklist

1. Add a ComicVine API key in **Settings > General**.
2. Add a Mylar3, Kapowarr, and/or BackIssue server in **Settings > Services**.
3. Mark one server across all comic services as the default. Requests without
   an explicitly selected server use this instance.
4. Enable **Sync** on each service you want scanned into SeerrNG's local
   availability data.
5. Set a default comic request quota in **Settings > Users** if you want to
   limit comic requests per user.
6. To give one user a different limit, open that user's profile settings and
   enable **Override Global Limit** under **Comic Request Limit**. Clear the
   override to return to the global limit.

## Known limitations

This is a first-pass integration; the following is a deliberate scope cut, not
a bug:

- Mylar3 does not expose per-request folder or profile choices through the API
  used by SeerrNG. Kapowarr supports a per-request root-folder choice for users
  with **Advanced Request** or **Manage Requests**; other requests use the
  folder configured for that Kapowarr server. BackIssue does not expose
  per-request download choices through the API used by SeerrNG. No comic
  backend exposes a quality-profile choice.
- Comic reports use the **Other** issue type with a structured reason for a
  missing issue, wrong edition or variant, damaged file, or incorrect
  metadata. The reason is saved and shown on the issue card and details page.
  Users with **Create Issues** can report problems for an available tracked
  comic; users with **View Issues** or **Manage Issues** can see open reports
  on comic details.

Users with **Manage Blocklist** can blocklist a comic from its detail page or
Discover card. Comic entries appear in the **Comics** filter on the Blocklist
page, where they can be removed.

Non-Plex users can add a comic to their SeerrNG watchlist from its detail page
or card. Users with **Auto-Request** and **Auto-Request Comics** can turn on
**Auto-Request Comics** in their profile to submit a comic request when they
add it to that watchlist.

Users with **Manage Requests** permission can open **Manage Comic** from a
tracked comic's details page. Administrators can open the comic in its backend,
remove it from the backend, mark it available, or clear its SeerrNG data.

Cancelling an active comic request removes it from Kapowarr's or BackIssue's
download queue directly. Mylar3 has no equivalent API to cancel an individual
in-progress download, so cancelling an active Mylar-backed request fails with
an error; wait for it to finish or remove the download manually in Mylar3 or
the download client first.

Kapowarr reports live download percent, size, and status. BackIssue reports
queue status and a percentage when available, but not download size or an ETA.
Mylar3 has no API for reading an in-progress download's status, so a
Mylar-backed request moves through requested, approved, and available without
a live progress bar in between.

## Troubleshooting

`No default Mylar, Kapowarr, or BackIssue server is configured`:

- confirm at least one comic service is added in **Settings > Services** and
  marked as the default.

BackIssue connection test fails:

- confirm SeerrNG can reach BackIssue's host and port from its own container.
- confirm the API key can manage the BackIssue library and that its URL base
  and HTTPS settings match BackIssue.
- confirm BackIssue has acquisition sources configured if adding a volume
  should start downloads.

Comic Discover page is empty:

- confirm a ComicVine API key is set in **Settings > General**.
- confirm the key is valid by checking the browser network tab for a 503 from
  `/api/v1/discover/comics`.

Kapowarr requests fail or time out:

- confirm the FlareSolverr container is running and reachable from Kapowarr.
- if a request appears to fail but the comic shows up in Kapowarr's own
  library shortly after, this is expected: a slow add can outlast SeerrNG's
  client-side timeout, and a retried dispatch resolves against the
  already-created volume instead of failing.
- for downloads that fail specifically from GetComics.org's direct link
  (not a mirror host), see the known GetComics reliability issue above —
  this is an upstream Kapowarr/indexer limitation, not a SeerrNG bug.
