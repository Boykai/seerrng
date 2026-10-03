import { MangaFollowStopReason } from '@server/constants/mangaFollow';
import { MediaRequestStatus } from '@server/constants/media';
import { Permission } from '@server/lib/permissions';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildMangaFollowBody,
  buildMangaFollowCreateField,
  getMangaFollowControlState,
  getMangaFollowState,
  getMangaFollowUrl,
  type MangaFollowControlInput,
} from './mangaFollow';

const OWNER_ID = 7;

const input = (
  overrides: Partial<MangaFollowControlInput> = {}
): MangaFollowControlInput => ({
  requestType: 'manga',
  requestStatus: MediaRequestStatus.APPROVED,
  requestedById: OWNER_ID,
  follow: { enabled: false, stopReason: null },
  userId: OWNER_ID,
  permissions: Permission.REQUEST,
  ...overrides,
});

describe('manga follow request helpers', () => {
  it('builds the follow route and body', () => {
    assert.equal(getMangaFollowUrl(31), '/api/v1/request/31/follow');
    assert.deepEqual(buildMangaFollowBody(true), { enabled: true });
    assert.deepEqual(buildMangaFollowBody(false), { enabled: false });
  });

  it('sends the create field only when following is chosen', () => {
    assert.deepEqual(buildMangaFollowCreateField(true), { mangaFollow: true });
    assert.deepEqual(buildMangaFollowCreateField(false), {});
  });

  it('reads the follow summary from a manga request', () => {
    assert.deepEqual(
      getMangaFollowState({
        mangaScope: {
          follow: {
            enabled: false,
            stopReason: MangaFollowStopReason.RANGE_COMPLETE,
            lastCheckAt: '2026-01-01T00:00:00.000Z',
            nextCheckAt: null,
          },
        },
      }),
      { enabled: false, stopReason: MangaFollowStopReason.RANGE_COMPLETE }
    );
    assert.deepEqual(
      getMangaFollowState({
        mangaScope: { follow: { enabled: true, stopReason: 'SOMETHING_NEW' } },
      }),
      { enabled: true, stopReason: null }
    );
  });

  it('reads no follow summary from other requests', () => {
    assert.equal(getMangaFollowState({}), undefined);
    assert.equal(getMangaFollowState({ mangaScope: null }), undefined);
    assert.equal(getMangaFollowState({ mangaScope: {} }), undefined);
    assert.equal(
      getMangaFollowState({ mangaScope: { follow: { enabled: 'yes' } } }),
      undefined
    );
  });
});

describe('manga follow control state', () => {
  it('lets the owner turn following on and off', () => {
    assert.deepEqual(getMangaFollowControlState(input()), {
      canTurnOn: true,
      canTurnOff: false,
    });
    assert.deepEqual(
      getMangaFollowControlState(
        input({ follow: { enabled: true, stopReason: null } })
      ),
      { canTurnOn: true, canTurnOff: true }
    );
  });

  it('accepts the manga request permission for the owner', () => {
    assert.deepEqual(
      getMangaFollowControlState(
        input({ permissions: Permission.REQUEST_MANGA })
      ),
      { canTurnOn: true, canTurnOff: false }
    );
  });

  it('allows turning on only while the request can still receive chapters', () => {
    for (const requestStatus of [
      MediaRequestStatus.PENDING,
      MediaRequestStatus.APPROVED,
      MediaRequestStatus.COMPLETED,
    ]) {
      assert.equal(
        getMangaFollowControlState(input({ requestStatus }))?.canTurnOn,
        true
      );
    }
    for (const requestStatus of [
      MediaRequestStatus.DECLINED,
      MediaRequestStatus.FAILED,
    ]) {
      assert.equal(getMangaFollowControlState(input({ requestStatus })), null);
      assert.deepEqual(
        getMangaFollowControlState(
          input({
            requestStatus,
            follow: { enabled: true, stopReason: null },
          })
        ),
        { canTurnOn: false, canTurnOff: true }
      );
    }
  });

  it('hides turning on from an owner who may no longer request manga', () => {
    assert.equal(
      getMangaFollowControlState(input({ permissions: Permission.NONE })),
      null
    );
    assert.deepEqual(
      getMangaFollowControlState(
        input({
          permissions: Permission.NONE,
          follow: { enabled: true, stopReason: null },
        })
      ),
      { canTurnOn: false, canTurnOff: true }
    );
  });

  it('lets a request manager only turn following off', () => {
    const manager = { userId: 1, permissions: Permission.MANAGE_REQUESTS };
    assert.equal(getMangaFollowControlState(input(manager)), null);
    assert.deepEqual(
      getMangaFollowControlState(
        input({ ...manager, follow: { enabled: true, stopReason: null } })
      ),
      { canTurnOn: false, canTurnOff: true }
    );
    assert.deepEqual(
      getMangaFollowControlState(
        input({
          userId: 1,
          permissions: Permission.ADMIN,
          follow: { enabled: true, stopReason: null },
        })
      ),
      { canTurnOn: false, canTurnOff: true }
    );
  });

  it('gives other users no control', () => {
    assert.equal(
      getMangaFollowControlState(
        input({
          userId: 2,
          permissions: Permission.REQUEST + Permission.REQUEST_MANGA,
          follow: { enabled: true, stopReason: null },
        })
      ),
      null
    );
    assert.equal(
      getMangaFollowControlState(input({ userId: undefined })),
      null
    );
  });

  it('treats a request without its requester as another user’s', () => {
    assert.equal(
      getMangaFollowControlState(
        input({
          requestedById: undefined,
          follow: { enabled: true, stopReason: null },
        })
      ),
      null
    );
    assert.deepEqual(
      getMangaFollowControlState(
        input({
          requestedById: undefined,
          permissions: Permission.MANAGE_REQUESTS,
          follow: { enabled: true, stopReason: null },
        })
      ),
      { canTurnOn: false, canTurnOff: true }
    );
  });

  it('gives no control without a follow summary or for other media', () => {
    assert.equal(
      getMangaFollowControlState(input({ follow: undefined })),
      null
    );
    assert.equal(
      getMangaFollowControlState(input({ requestType: 'book' })),
      null
    );
  });
});
