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
