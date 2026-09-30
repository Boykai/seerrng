import { MediaServerType } from '@server/constants/server';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasWatchAheadMediaServerLink,
  isPlexPlaybackSessionForUser,
  isWatchAheadMediaServer,
} from './watchAheadEligibility';

describe('requested episode queue media server eligibility', () => {
  it('supports Plex, Jellyfin, and Emby', () => {
    assert.equal(isWatchAheadMediaServer(MediaServerType.PLEX), true);
    assert.equal(isWatchAheadMediaServer(MediaServerType.JELLYFIN), true);
    assert.equal(isWatchAheadMediaServer(MediaServerType.EMBY), true);
    assert.equal(
      isWatchAheadMediaServer(MediaServerType.NOT_CONFIGURED),
      false
    );
  });

  it('uses the provider-specific linked identity', () => {
    assert.equal(
      hasWatchAheadMediaServerLink({ plexId: 12 }, MediaServerType.PLEX),
      true
    );
    assert.equal(
      hasWatchAheadMediaServerLink(
        { jellyfinUserId: 'linked-user' },
        MediaServerType.JELLYFIN
      ),
      true
    );
    assert.equal(
      hasWatchAheadMediaServerLink(
        { jellyfinUserId: 'linked-user' },
        MediaServerType.EMBY
      ),
      true
    );
    assert.equal(hasWatchAheadMediaServerLink({}, MediaServerType.PLEX), false);
  });

  it('matches Plex playback only when the session identifies the linked user', () => {
    const user = { plexId: 12, plexUsername: 'LinkedUser' };

    assert.equal(isPlexPlaybackSessionForUser({ userId: '12' }, user), true);
    assert.equal(
      isPlexPlaybackSessionForUser({ username: 'linkeduser' }, user),
      true
    );
    assert.equal(isPlexPlaybackSessionForUser({}, user), false);
    assert.equal(
      isPlexPlaybackSessionForUser({ userId: '34', username: 'other' }, user),
      false
    );
  });
});
