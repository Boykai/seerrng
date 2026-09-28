# Discovery integrations

SeerrNG can connect personal Trakt, AniList and Simkl accounts. Administrator
application credentials and personal account credentials are separate. Connecting
a tracker does not enable signing in to SeerrNG with that tracker.

## Application setup

Open **Settings → Discovery Integrations** as an administrator. Configure the
application Client ID and secret for Trakt or AniList, the application Client ID
for Simkl, and an API key for MDBList. AniList uses its PIN authorization redirect:
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

Titles with confirmed TMDB IDs use the normal movie/series cards. Titles without
a confirmed match retain their original provider identity and are marked
**Catalog match pending**. SeerrNG does not invent an ID from a matching title.

## Release calendar

**Calendar** displays movie releases and series episodes from configured Radarr
and Sonarr services. **My requests** is the default scope and follows the
request's standard or 4K format. Users with request-view or management permissions
can select the shared calendar. Only administrators can include unmonitored titles.

Movie dates are displayed as calendar dates. Episode air times use your browser's
time zone. If a service is unavailable, the calendar identifies the missing source
and keeps results from successful services. Results and backend reads are bounded;
narrow the month or media type when the result limit is reached.
