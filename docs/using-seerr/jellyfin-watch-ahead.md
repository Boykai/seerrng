---
title: Jellyfin episode watch-ahead
description: Keep a small buffer of upcoming TV episodes requested in Sonarr as you watch in Jellyfin.
---

# Jellyfin episode watch-ahead

Watch-ahead lets a TV request owner ask SeerrNG to keep up to five upcoming
episodes requested in Sonarr as they watch the series in Jellyfin. It is
opt-in for each request.

## Requirements

- SeerrNG uses Jellyfin as its media server.
- Your SeerrNG account is linked to the matching Jellyfin user.
- You have permission to request the TV quality selected for the request.
- The series has a TVDB identity so Jellyfin playback can be matched to it.
- A matching Sonarr destination is configured for the request's standard or 4K
  quality.

## Turn it on or off

When creating or editing your own TV request, choose a buffer under **Keep
upcoming episodes requested**. You can also change it later from that request's
card in **Requests** or **Request Status**. Only the request owner can change
the setting; administrators cannot enable it for someone else.

Choose **Off** to stop future watch-ahead requests. Episodes already created
remain in Sonarr and in SeerrNG's request history. Turn watch-ahead off before
removing an episode request you do not want; while it remains on, SeerrNG may
add a missing episode again if it is needed to maintain the selected buffer.

## What SeerrNG does

By default, the worker checks active Jellyfin playback every 30 seconds. It advances only
when Jellyfin marks the matching episode played and the session has reached at
least 90% of that episode's runtime. It matches the playing series and Jellyfin
user to the TV request owner; another user's playback does not advance your
request.

While the TV request is pending approval, SeerrNG remembers your watched
progress but waits to add episodes. After the parent request is approved,
SeerrNG checks the selected Sonarr library and requests enough upcoming,
missing episodes to maintain the buffer. Episodes already in the library,
monitored by Sonarr, or covered by another active request count toward that
buffer. Specials follow the administrator's **Enable Special Episodes**
setting.

Generated episode requests inherit the approved parent request and do not use
additional request quota. They appear in Requests with a **Requested ahead of
playback** label and do not create a separate approval notification for every
episode. Sonarr remains responsible for searching, downloading, importing, and
tracking the files.

## API

The request owner can update a request through
`PUT /api/v1/request/{requestId}/watch-ahead` with a JSON body such as:

```json
{ "episodeCount": 3 }
```

Use `episodeCount: 0` to disable future additions. Values from 0 through 5 are
accepted. The endpoint requires a linked Jellyfin account and a matching
Sonarr destination when enabling watch-ahead.
