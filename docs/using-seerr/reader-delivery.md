---
title: Deliver ebooks, audiobooks, comics, and magazines to reader apps
description: Set up Grimmory or BookOrbit for reader catalogs and deliver requested media to compatible devices.
sidebar_position: 26
---

# Deliver books and issues to reader apps

SeerrNG connects your existing media libraries to compatible readers through
Grimmory or BookOrbit. Grimmory is recommended and stays the preferred service
by default. You can configure either service or both.

SeerrNG does not copy files into Grimmory or BookOrbit. The reader service must
index the files it will show in its catalogs and players. SeerrNG also offers
protected downloads for available files attached to your own requests, so you
can save them directly to the device running this browser.

## What works with each service

| Media | Grimmory | BookOrbit |
| --- | --- | --- |
| Ebooks | OPDS catalog and Grimmory readers | OPDS catalog |
| Audiobooks | Grimmory library player for M4B, M4A, and MP3; SeerrNG can also download available requested files | BookOrbit web player for M4B, MP3, M4A, OPUS, OGG, and FLAC; audio is not available through OPDS; SeerrNG can also download available requested files |
| Comics | Komga API for comic apps that stream pages; SeerrNG can download available requested files | Built-in reader for CBZ, CBR, and CB7; OPDS can download CBZ and CBR; SeerrNG can also download available requested files |
| Magazine issues | Import PDF issues in the library to browse them through OPDS; SeerrNG can download available requested issues | Import PDF issues in the library to browse them through OPDS; SeerrNG can download available requested issues |

OPDS gives reader apps a catalog for browsing and downloading supported files.
BookOrbit's built-in web readers handle its audiobook and comic formats, while
third-party OPDS apps cannot stream audiobooks and can download only supported
comic archives. Grimmory's Komga API is the better path for comic apps that
stream one page at a time. Magazine issues do not have a separate magazine
catalog in these integrations; the reader service must index them as PDF files.
Reader support still depends on the device app and the file format.

## 1. Make the files visible to your reader service

Import or mount the relevant media folders into Grimmory or BookOrbit and run
that service's library scan. If you use containers, use the path as it appears
inside the reader service. The files can live in the same shared storage even
when their container paths differ.

For example, if a host directory is mounted at /books in Bookshelf and at
/library in Grimmory, configure Grimmory to scan /library. Keep the library
manager's paths stable. Do not enable reader-service options that move or
rename files unless you also update the manager's paths.

Create OPDS reader accounts in Grimmory or BookOrbit and enter those
credentials in the reading app. To let SeerrNG manage live reader shelves,
also save a service account in SeerrNG: a Grimmory administrator account for
Grimmory Magic Shelves, or a BookOrbit account for BookOrbit Smart Scopes.
These are separate credentials: SeerrNG uses the service account to manage
Magic Shelves and Smart Scopes; reader apps still use their OPDS credentials.

See the [Grimmory OPDS guide](https://grimmory.org/docs/integration/opds/),
[Grimmory Komga API guide](https://grimmory.org/docs/integration/komga-api/),
[Grimmory Magic Shelves guide](https://grimmory.org/docs/magic-shelf/),
[BookOrbit OPDS guide](https://bookorbit.app/opds), and
[BookOrbit Smart Scopes guide](https://bookorbit.app/smart-scopes) for their
setup steps.

## 2. Configure Reader Apps in SeerrNG

Open **Settings > Services > Reader Apps**.

1. Enter an address the reading device can reach. For Grimmory, include any
   reverse-proxy base path; you can paste the service address or its full OPDS
   or Komga API address. For BookOrbit, you can paste the service address or
   its full OPDS address. BookOrbit has no base-path setting, so a reverse
   proxy that serves it under a sub-path must remove that path before
   forwarding requests.
2. Configure Grimmory, BookOrbit, or both. Choose a preferred service. If it
   has no address, SeerrNG uses the other configured service.
3. Save the settings. Copy the generated OPDS address into an ebook app. For
   Grimmory, copy the separate Komga address into a compatible comic app.

Use a LAN hostname or public reverse-proxy address when the reader is on
another device. localhost and Docker-only service names generally refer to the
reading device itself. The device must resolve the host and trust its HTTPS
certificate.

For SeerrNG-managed shelves, enter an account for each configured service:

- **Grimmory**: a Grimmory administrator account that signs in with a
  password. SeerrNG previews, creates, and updates Grimmory Magic Shelves with
  it.
- **BookOrbit**: a BookOrbit account that signs in with a password and can see
  the libraries with your books. If BookOrbit gave the account a temporary
  password, sign in to BookOrbit with it once to replace that password.
  SeerrNG creates BookOrbit Smart Scopes as this account, so keep using the
  same account to update or remove them.

Use **Test Magic Shelf Access** or **Test Smart Scope Access** to check the
address and account before or after saving. The test uses the values in the
form. Leave the password blank to test or keep the saved password; this works
only while the address and username stay the same, so enter the password again
after you change either one. A failed test names the step that failed, such as
signing in or listing Magic Shelves or Smart Scopes, and what to check. SeerrNG
stores the password in its private settings file and redacts it from settings
API responses. Select **Remove saved account credentials** and save to remove
it. The saved account is used for shelf management; it is not the OPDS account
used by readers.

The Grimmory Komga API must be enabled under its OPDS settings before a comic
app can use that address. Grimmory's OPDS and Komga APIs share reader
credentials. The SeerrNG link opens the configured Grimmory endpoint; enter its
address and credentials in a Komga-compatible reader app.

## Create a live reader shelf from SeerrNG

Administrators can create a live, rule-based shelf from an author, book-series,
or comic-series page. Open **Create reader shelf**, choose Grimmory or
BookOrbit, and preview the current matches and sample titles before saving. The
rule is managed by the reader service, so future matching books appear when
that service refreshes its library. SeerrNG does not copy, move, or delete
library files when it creates a shelf.

Keep **Show this grouping to other reader-service users** on when your reader
or OPDS account belongs to a different reader-service user than the account
connected in SeerrNG. The reader account also needs access to the matching
library. BookOrbit public Smart Scopes appear in OPDS feeds; private Smart
Scopes are only visible to their owner. SeerrNG sets a BookOrbit Smart Scope's
visibility only when it creates the Smart Scope, so change it later in
BookOrbit. For BookOrbit v2.2 or
later, **Sync this BookOrbit scope to the connected Kobo account** enables
sync for the service account configured in SeerrNG. Grimmory's Kobo inclusion
shelf is separate and is left unchanged. SeerrNG reports the saved grouping
status and item count when the service confirms it. If there are no current
matches, you must explicitly allow an empty rule before saving so books added
later can appear.

Remove a SeerrNG-managed shelf under **Settings > Services > Reader Apps**.
This removes the reader-service grouping and SeerrNG's mapping only; it does not
delete books or library files.

## 3. Download or browse from a media page

Open a book, comic, or magazine in SeerrNG.

- **Browse ebooks** opens the selected reader service in a browser so you can
  search its library. To use an e-reader app, copy the OPDS address under
  **Settings > Services > Reader Apps**, add it in that app, and sign in with
  the reader-service credentials.
- **Open audiobook library** opens the selected reader service. Find the
  audiobook in that service's library and use its player. BookOrbit supports
  M4B, MP3, M4A, OPUS, OGG, and FLAC in its web player; these files are not
  delivered through OPDS.
- **Browse comics** opens the selected reader service. BookOrbit's web library
  reads CBZ, CBR, and CB7. For page streaming in a separate comic app, copy
  Grimmory's Komga address under **Settings > Services > Reader Apps**.
  BookOrbit OPDS lists CBZ and CBR downloads.
- **Browse magazine PDFs** opens the preferred reader service. Import magazine
  issues as PDF files there first; OPDS does not preserve magazine-specific
  issue organization. Add the service's OPDS address to a reader app from
  **Settings > Services > Reader Apps**.
- **Download ebook, Download audiobook, Download comic, or Download issue**
  appears when the signed-in user has an available request with a file SeerrNG
  can resolve. If there are multiple files, choose the requested issue or
  format from the list. The downloaded copy is saved by this browser to the
  device running SeerrNG.

Direct downloads require the request to be available and accessible to the
signed-in user. For files served from the manager's storage, open
**Settings > General > Download Copies** and add a library path mapping for
each relevant service. Map the path reported by the manager to the read-only
path mounted inside SeerrNG. Use narrow roots so only the intended library is
available. Mylar3 comic issues are streamed through its API and do not use a
local path mapping.

If a download action is missing, open **Request Status** and confirm that the
request belongs to the signed-in user and is available. Check that the manager
reports a file and that its path maps to a regular file inside SeerrNG's
configured root. The endpoint verifies the file remains inside that root before
serving it. When a manager is temporarily unavailable, any copies SeerrNG
could still resolve remain available and the download action links to Request
Status to check other copies. A reader-service catalog is still useful for
browsing library items that were not requested through SeerrNG.

## What SeerrNG tracks

SeerrNG tracks requests, service availability, and the status/count of shelves
it manages. The reader service owns its library scan, audiobook playback,
reading progress, highlights, and annotations. OPDS or Komga links do not
confirm that a device has connected, that the service has indexed a file, or
that a device synchronized its progress. For service-side issues, check the
reader app's library scan and account permissions.
