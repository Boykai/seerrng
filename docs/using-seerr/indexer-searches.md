---
title: Indexer searches by media category
description: See where title discovery happens and how Prowlarr supplies acquisition indexers for each SeerrNG category.
---

# Indexer searches by media category

SeerrNG does **not** send searches to Prowlarr. SeerrNG searches catalogs to
identify titles and manages requests. The configured media manager or software
provider performs the acquisition search after a request is approved. Prowlarr
can supply indexers to destinations that support Prowlarr sync; it does not
replace the catalog used by SeerrNG.

| SeerrNG category | Title discovery in SeerrNG | Acquisition search | Where Prowlarr fits |
| --- | --- | --- | --- |
| Movies | TMDB | Radarr | Sync compatible movie indexers to Radarr. |
| TV | TMDB | Sonarr | Sync compatible TV indexers to Sonarr. |
| Music | MusicBrainz and music metadata sources | Lidarr | Sync compatible music indexers to Lidarr. |
| Ebooks and audiobooks | Open Library, configured Bookshelf catalogs, and book metadata providers | BookshelfNG, Chaptarr, or another configured Readarr-compatible service | Prowlarr's Readarr app can sync book indexers to a compatible destination. Confirm that the specific Bookshelf build accepts and uses synced indexers. SeerrNG sends no Prowlarr search request. |
| Comics | ComicVine | Mylar3, or Kapowarr's direct-download sources | Prowlarr can sync indexers to Mylar3. Kapowarr uses GetComics and its mirror hosts, so adding Prowlarr does not add indexers to Kapowarr. |
| Magazines | Tracked LazyLibrarian catalogs; untracked titles can be requested by name | LazyLibrarian | Prowlarr has a LazyLibrarian app adapter. Sync supported categories and verify the indexers appear and search in your LazyLibrarian build. |
| PC games | IGDB through QuestarrNG | QuestarrNG | QuestarrNG supports Prowlarr-synced indexers. The game catalog remains IGDB. |
| Retro and Modern ROMs | IGDB through QuestarrNG, matched to ROMarrNG systems | ROMarrNG | ROMarrNG can use Prowlarr or direct Torznab/Newznab sources; plugin sources are also available. |

Prowlarr sync depends on an indexer's reported categories and the sync
categories selected for each destination. An indexer may be configured in
Prowlarr yet not be sent to a particular app if its categories do not match.
After sync, check the destination app's indexer list and search settings. For
Mylar3, verify the synced providers are enabled in Mylar. For LazyLibrarian,
run a search there after syncing because its app API varies across builds.

When searching directly inside Prowlarr, its own download client is used. For
searches started by an app, that app's configured download client handles the
grab. SeerrNG requests do not use Prowlarr's direct-search download client.

Use the relevant setup guide for [comics](./comics-backend.md),
[magazines](./magazines-backend.md),
[books and audiobooks](./bookshelf-backend.md), or
[ROMs and PC games](./software-acquisition.md).

Prowlarr documents its supported app integrations and category-based sync in
the [Prowlarr README](https://github.com/Prowlarr/Prowlarr) and [quick-start guide](https://github.com/Servarr/Wiki/blob/master/prowlarr/quick-start-guide.md).
QuestarrNG's [supported indexers](https://github.com/snapetech/QuestarrNG#supported-indexersdownloaders)
include Prowlarr synchronization. Check the destination app after every sync;
an indexer only reaches it when the app accepts its categories and the app's
search settings enable that provider.
