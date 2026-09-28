---
title: Indexer searches by media category
description: Connect Prowlarr to SeerrNG for manual category-aware indexer searches and understand how approved requests reach media managers.
---

# Indexer searches by media category

Administrators can connect one Prowlarr instance under **Settings > Services >
Prowlarr indexers**. SeerrNG then provides **Indexer Search** for users with
**Manage Requests** permission. The page searches Prowlarr directly across
movies, TV, music, ebooks, audiobooks, comics, magazines, retro ROMs, modern
ROMs, and PC games.

This is a manual search for inspecting available releases. SeerrNG does not
grab a result, send it to a download client, or add it to a media library from
this page. An approved request still goes to its configured media manager or
software provider, which owns acquisition, import, and progress tracking.

| SeerrNG category | Title discovery in SeerrNG | Manual Prowlarr search | Approved request acquisition |
| --- | --- | --- | --- |
| Movies | TMDB | Configured movie category IDs | Radarr |
| TV | TMDB | Configured TV category IDs | Sonarr |
| Music | MusicBrainz and music metadata sources | Configured audio category IDs | Lidarr |
| Ebooks | Open Library, Bookshelf catalogs, and book metadata providers | Configured ebook/book category IDs | BookshelfNG, Chaptarr, or another configured book service |
| Audiobooks | Book metadata catalogs and configured Bookshelf catalogs | Configured audiobook/audio category IDs | BookshelfNG, Chaptarr, or another configured book service |
| Comics | ComicVine | Configured comic/book category IDs | Mylar3 or Kapowarr's direct-download sources |
| Magazines | Google Books public catalog or titles tracked by LazyLibrarian | Configured magazine/book category IDs | LazyLibrarian |
| Retro and Modern ROMs | IGDB through QuestarrNG, matched to ROMarrNG systems | Configured console/game category IDs | ROMarrNG |
| PC games | IGDB through QuestarrNG | Configured PC/game category IDs | QuestarrNG |

## Configure Prowlarr

1. Open **Settings > Services > Prowlarr indexers** as an administrator.
2. Enter the Prowlarr hostname, port, optional base path, SSL setting, and API
   key. The API key stays on the SeerrNG server and is masked after saving.
3. Select **Test connection and inspect coverage**. SeerrNG shows the enabled,
   searchable indexers and how many advertise at least one selected category
   for each medium.
4. Review **Category filters** and save. Defaults use the standard movie, TV,
   audio, book, console-generation, and PC-game categories. Prowlarr's broad
   Audio category can include audiobooks; select narrower music categories if
   you want to keep those results separate. The broad PC category can also
   include non-game software; select PC/Games for a narrower search. Your
   Prowlarr indexers can report custom category IDs, which appear after a
   successful connection test; select the IDs that fit your indexer setup.

The **Retro ROMs**, **Modern ROMs**, and **PC games** filters start with
generation-specific standard console categories and the broad PC category.
Prowlarr's standard console list ends at PS4 and Xbox One; newer
systems such as PS5 and Xbox Series may use custom categories. After testing
the connection, add the matching categories shown by Prowlarr to the relevant
SeerrNG filter. SeerrNG does not infer a console generation from a game's
title.

Coverage counts are an estimate based on the categories each enabled indexer
advertises. A nonzero count does not guarantee that an indexer returns results
for a particular title or that a media manager can import a release. A zero
count means the selected category IDs do not match any enabled searchable
indexer in the current inventory.

## Search indexers

Users with **Manage Requests** open **Indexer Search** from the navigation,
select a media category, enter at least two search characters, and choose
**Search indexers**. Results show release title, source indexer, protocol,
size, seeders and leechers when provided, publish date, and indexer categories.
When Prowlarr supplies a safe HTTP or HTTPS details link, users can open it in a
new tab. Sensitive query parameters are removed from that link.

Searches are limited to 50 results per page and 12 searches per minute per
client IP. **Load more results** requests another page. Search results are
informational; SeerrNG does not expose download or magnet URLs from the search
API.

## Keep request acquisition separate

Prowlarr can also sync compatible indexers to supported applications. That
sync is useful to Radarr, Sonarr, Lidarr, and whichever book or comic services
accept the relevant Prowlarr integration. After syncing, check the destination
application's indexer and search settings. Some providers do not support
Prowlarr or use direct-download sources instead.

For a SeerrNG request, the configured media manager or software provider
continues to perform its own search, grab, import, and tracking. Prowlarr's
manual search page does not alter request state or hand a result to a
download client.

See the setup guides for [books and audiobooks](./bookshelf-backend.md),
[comics](./comics-backend.md), [magazines](./magazines-backend.md), and
[ROMs and PC games](./software-acquisition.md). Prowlarr documents its
supported application integrations and category-based indexer management in
the [Prowlarr README](https://github.com/Prowlarr/Prowlarr) and
[quick-start guide](https://github.com/Servarr/Wiki/blob/master/prowlarr/quick-start-guide.md).
