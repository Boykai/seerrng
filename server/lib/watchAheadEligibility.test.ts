import { MediaServerType } from '@server/constants/server';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasWatchAheadMediaServerLink,
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
});
