---
title: Books, Authors, and Series
description: Browse book catalogs, explore authors and series, and request book formats.
---

# Books, Authors, and Series

SeerrNG can search books through Open Library and the catalogs exposed by your
connected Bookshelf-compatible services. The available titles, editions,
authors, and series depend on those catalogs.

## Browse and search

1. Open **Books** or **Audiobooks** from the navigation menu to browse that
   format.
2. Use the page search and filters to narrow results by title, publication
   year, subject, language, or rating.
3. To search across catalogs, open **Search**, enter a title or author, and
   choose **Books**, **Audiobooks**, or **Authors**.
4. Select a book to open its details. When the catalog supplies author or
   series information, the author and series names link to their own pages.

An author page lists books associated with that author. A book series page
lists its catalog volumes in series order when positions are available. Each
volume shows ebook and audiobook availability separately as **Available**,
**Requested**, or **Missing**.

## Request volumes from a series

On a series page, select **Request Missing Books** to open the multi-book
request dialog. Review the volumes and choose the book format and destination
for the titles you want. Normal request permissions, quotas, approval rules,
and service configuration still apply.

You can also open a volume's book details and request it individually. The
request dialog supports books, audiobooks, or both when matching services are
configured. To keep a particular edition, choose it in the edition selector;
see [Requesting a specific edition](./bookshelf-backend.md#requesting-a-specific-edition).
Book issue reports include reasons for missing content, a wrong edition,
damaged files, and incorrect metadata. The selected reason stays visible on
the issue card and details page, alongside the requester's explanation.

## Set language preferences

Preferred request languages can prioritize a matching book edition in the
request dialog. Users can set a default language and a separate book-language
override in their user settings. See
[Preferred Request Languages](./users/editing-users.md#preferred-request-languages)
for how those preferences affect requests.

## Configure book services

An administrator must connect a Bookshelf or other Readarr-compatible service
under **Settings > Services**. Configure a default service for each format you
want to offer. See the [Bookshelf backend guide](./bookshelf-backend.md) for
service setup and
[Bookshelf Metadata Sources](./bookshelf-metadata-sources.md) for catalog
behavior and provider-specific requirements.

Prowlarr can sync book indexers through its Readarr app adapter when the
configured Bookshelf-compatible service accepts that indexer configuration.
The exact support depends on the provider build. SeerrNG searches book
metadata catalogs and does not send acquisition searches to Prowlarr; see
[Indexer searches by media category](./indexer-searches.md).
