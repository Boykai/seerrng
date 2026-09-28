# Download Inbox

Open **Download Inbox** to review warnings from enabled Radarr, Sonarr, Lidarr,
and Readarr/Bookshelf services. Normal downloads are omitted. Administrators have
access automatically; grant **Manage Downloads** to other staff who need this
access. This permission includes all configured acquisition queues, including
items acquired outside SeerrNG. Manage Requests alone does not grant it.

## Import files

For a movie or series warning, select **Preview files**, review the matching and
rejection reasons, and select files. Only files with a confirmed movie or episode
target are selectable. Choose copy/hardlink to preserve source files, or explicitly
choose move. The backend determines how copy/hardlink behaves on its filesystem.

SeerrNG obtains paths and matching metadata from the acquisition service and
rechecks the preview before submission. Changed files require a new preview.
**Import pending** means the command was accepted; completion requires a matching
backend import event. Failed or uncertain outcomes remain visible for review.
Unmatched files and music/book manual imports currently require the acquisition
service's own interface.

## Reject downloads

Select **Reject download**, review the options, and confirm. Blocklisting prevents
this release from being chosen again. Removing the download and its files from the
download client is a separate option and starts unchecked. Backend policy determines
replacement searches and client behavior.

## History and refresh

Resolved warnings appear in **History**, including the actor, action options, and
outcome. Each warning retains up to 50 attempts. Resolved history is retained for
90 days, with at most 2,000 resolved warnings per service. Warnings are also observed
during the existing download recovery job; the inbox coalesces complete queue reads
for 30 seconds and checks up to 20 services. Unavailable or oversized queues are
reported as partial sources, rather than treating unread downloads as disappeared.
