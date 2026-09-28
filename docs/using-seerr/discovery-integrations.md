# Discovery integrations

SeerrNG can connect personal Trakt, AniList and Simkl accounts. Administrator
application credentials and personal account credentials are separate. Connecting
a tracker does not enable signing in to SeerrNG with that tracker.

## Application setup

Open **Settings → Discovery Integrations** as an administrator. Configure the
application Client ID and secret for Trakt or AniList, the application Client ID
for Simkl, and an API key for MDBList. The MDBList key also enables optional
aggregated ratings on movie and series details, poster rating popovers, and
collection averages. SeerrNG uses MDBList values where direct Rotten Tomatoes or
IMDb ratings are missing and adds Metacritic and Trakt scores; an MDBList outage
does not hide ratings from other sources. AniList uses its PIN authorization redirect:
`https://anilist.co/api/v2/oauth/pin`.

Secrets are hidden after saving. Editing only one field retains the other saved
values. **Clear this integration** prepares removal of its credentials; save the
settings to apply it. Changing a provider's Client ID invalidates connections
created for the previous application.

## Connect a personal account

Open **Profile → Settings → Linked Accounts → Discovery Accounts**. Choose
**Connect**, follow the provider authorization page, and approve the connection.
Trakt and Simkl display an authorization code and wait for confirmation. AniList
provides a code to paste into SeerrNG. You can cancel or disconnect a connection.

## Browse

Use **Explore provider recommendations and lists** on Discover. Trakt offers
personal recommendations, watchlists and history. AniList offers anime catalogs
and your linked anime library. MDBList accepts public list URLs or list IDs.

When you connect a personal account, Discover also shows a **Picked for You**
section with that account's available rows: Trakt movie and series
recommendations and watchlist, plus AniList and Simkl planning and in-progress
lists. Rows with no titles are hidden. These rows use the signed-in user's
connection and keep provider titles visible when SeerrNG cannot confirm a TMDB
match.

Titles with confirmed TMDB IDs use the normal movie/series cards. Titles without
a confirmed match retain their original provider identity and are marked
**Catalog match pending**. Search the SeerrNG catalog and confirm a movie or
series to attach a private match to a stable Trakt, AniList, or MDBList ID.
When a source also supplies an IMDb or TVDB ID, SeerrNG can resolve that exact
ID through TMDB and use the result only when it is unique, has the expected
movie or series type, and still exists in the catalog. Ambiguous or unavailable
results remain available for manual repair. An exact-ID result is shown as
automatic; choose **Change title match** to save a private override. The
**Show unmatched titles** filter keeps the remaining repair queue visible on the
current feed page. Private matches are also used in My Library when the same
provider item appears there. Provider IDs are preserved; SeerrNG does not infer
a match from title text.
Provider errors identify whether an account needs reconnecting, MDBList setup is
missing, an MDBList list is unavailable, or the provider is temporarily down.
When a provider reports a quota cooldown, Retry stays disabled until that window
ends.

## Personal library and tracking

Open **My Library** to browse your connected Trakt, AniList, or Simkl account,
or the movie and series libraries visible to your linked Plex, Jellyfin, or
Emby account. Media-server libraries are read-only in SeerrNG and use your own
provider account, so libraries hidden from that account are not shown. Choose a
server library and browse its all, watched, unwatched, or in-progress shelf.
Only media-server libraries enabled in SeerrNG and visible to your linked
account appear. Watched and unwatched filters use that account's playback state;
in-progress includes partially played movies and series. Sparse in-progress
results are filled from bounded provider batches. A status notice appears when a
page reaches its scan limit; **Next** continues from the returned cursor while
more results are available, up to SeerrNG's safety cap. Link the media-server
account under **Profile → Settings**; tracking-account connections remain under
**Linked Accounts**.

Trakt shelves are paged separately for movies and series. AniList and Simkl
show the linked user's native library and keep provider IDs when a confirmed
TMDB match is unavailable. Use **Match catalog title** to choose a confirmed
movie or series for an unmatched item; the saved match is private to your user
and can be changed or reset later. Simkl anime entries stay unmapped until the
identity and media type can be confirmed.

Provider writes are off by default. To enable them, turn on the explicit
watched-status, progress, and rating consent for each account under **Linked
Accounts**. SeerrNG only sends a change after you choose an action on a title.
AniList ratings retain its tenth-point scale and anime episode progress is
bounded by the provider's current episode count. Trakt and Simkl ratings use
whole-number 1–10 values; choose **Remove rating** to clear one. Changing a
series watched state applies to the whole series, and SeerrNG asks you to
confirm. Removing a movie's watched state also asks for confirmation.

When a provider does not confirm a write, SeerrNG records the outcome as
uncertain and will not automatically repeat that action. Check the provider
account before choosing the same change again.

## Back up title matches

The **Personal title matches** section at the top of **My Library** exports a
versioned JSON pack of your saved provider-to-catalog matches. Choose that file
to restore it on another SeerrNG install; the import preview reports how many
matches it contains before you apply it. Existing matches for the same provider
item are updated, and matches for other users are never changed. Packs contain
provider item IDs and TMDB IDs only, not account tokens or application secrets.
An import can be restored before you reconnect the provider accounts; the
matches take effect when those items appear in a library or discovery feed.

## Release calendar

**Calendar** displays movie releases and series episodes from configured Radarr
and Sonarr services. **My requests** is the default scope and follows the
request's standard or 4K format. Users with request-view or management permissions
can select the shared calendar. Only administrators can include unmonitored titles.

Movie dates are displayed as calendar dates. Episode air times use your browser's
time zone. If a service is unavailable, the calendar identifies the missing source
and keeps results from successful services. Results and backend reads are bounded;
narrow the month or media type when the result limit is reached.
