import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canLoadRequestStatus,
  resolveRequestStatusUserSelection,
} from './requestStatusQuery';

describe('resolveRequestStatusUserSelection', () => {
  it('shows all users by default to request managers', () => {
    assert.equal(
      resolveRequestStatusUserSelection({ canViewOtherUsers: true }),
      'all'
    );
  });

  it('keeps an explicitly selected user', () => {
    assert.equal(
      resolveRequestStatusUserSelection({
        canViewOtherUsers: true,
        queryUserId: '42',
      }),
      42
    );
  });

  it('limits users without cross-user permission to their own API scope', () => {
    assert.equal(
      resolveRequestStatusUserSelection({
        canViewOtherUsers: false,
        queryUserId: '42',
      }),
      null
    );
  });
});

describe('canLoadRequestStatus', () => {
  it('loads an unscoped query for the All Users selection', () => {
    assert.equal(
      canLoadRequestStatus({
        currentUserId: 1,
        canViewOtherUsers: true,
        selectedUser: 'all',
      }),
      true
    );
  });

  it('waits for a manager user selection to initialize', () => {
    assert.equal(
      canLoadRequestStatus({
        currentUserId: 1,
        canViewOtherUsers: true,
        selectedUser: null,
      }),
      false
    );
  });

  it('loads the current user view without a manager selection', () => {
    assert.equal(
      canLoadRequestStatus({
        currentUserId: 2,
        canViewOtherUsers: false,
        selectedUser: null,
      }),
      true
    );
  });
});
