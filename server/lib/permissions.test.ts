import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MAX_PERMISSION_VALUE,
  Permission,
  hasAutoApprovePermission,
  hasPermission,
  isValidPermissionValue,
} from './permissions';

describe('permission masks', () => {
  it('supports permission bits beyond JavaScript bitwise integer range', () => {
    const permissions = Permission.REQUEST_MUSIC + Permission.REQUEST_BOOK;

    assert.equal(hasPermission(Permission.REQUEST_MUSIC, permissions), true);
    assert.equal(hasPermission(Permission.REQUEST_BOOK, permissions), true);
    assert.equal(hasPermission(Permission.ADMIN, permissions), false);
  });

  it('fails closed on corrupt or unsupported persisted values', () => {
    for (const value of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_PERMISSION_VALUE + 1,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      assert.equal(isValidPermissionValue(value), false);
      assert.equal(hasPermission(Permission.ADMIN, value), false);
      assert.equal(hasPermission(Permission.REQUEST_BOOK, value), false);
    }
  });
});

describe('request auto approval', () => {
  it('uses the request owner permissions for each media type and quality', () => {
    assert.equal(
      hasAutoApprovePermission(Permission.AUTO_APPROVE_MOVIE, 'movie'),
      true
    );
    assert.equal(
      hasAutoApprovePermission(Permission.AUTO_APPROVE_MOVIE, 'tv'),
      false
    );
    assert.equal(
      hasAutoApprovePermission(Permission.AUTO_APPROVE_4K_MOVIE, 'movie', true),
      true
    );
    assert.equal(
      hasAutoApprovePermission(Permission.AUTO_APPROVE_MOVIE, 'movie', true),
      false
    );
    assert.equal(
      hasAutoApprovePermission(Permission.AUTO_APPROVE_MUSIC, 'music'),
      true
    );
    assert.equal(
      hasAutoApprovePermission(Permission.AUTO_APPROVE_BOOK, 'book'),
      true
    );
  });

  it('treats administrators and request managers as auto-approved owners', () => {
    assert.equal(hasAutoApprovePermission(Permission.ADMIN, 'book'), true);
    assert.equal(
      hasAutoApprovePermission(Permission.MANAGE_REQUESTS, 'tv', true),
      true
    );
  });
});

describe('manga permissions', () => {
  it('use the three bits after MANAGE_DOWNLOADS', () => {
    assert.equal(Permission.MANAGE_DOWNLOADS, 2 ** 43);
    assert.equal(Permission.AUTO_APPROVE_MANGA, 2 ** 44);
    assert.equal(Permission.REQUEST_MANGA, 2 ** 45);
    assert.equal(Permission.AUTO_REQUEST_MANGA, 2 ** 46);

    const values = Object.values(Permission).filter(
      (value): value is number => typeof value === 'number' && value !== 0
    );
    assert.equal(new Set(values).size, values.length);
    for (const value of values) {
      assert.equal(Number.isSafeInteger(value), true);
      assert.equal(BigInt(value) & (BigInt(value) - 1n), 0n);
    }
    assert.equal(
      MAX_PERMISSION_VALUE,
      values.reduce((sum, value) => sum + value, 0)
    );
  });

  it('accept and check masks that use the manga bits', () => {
    const permissions =
      Permission.REQUEST +
      Permission.REQUEST_MANGA +
      Permission.AUTO_REQUEST_MANGA;

    assert.equal(isValidPermissionValue(permissions), true);
    assert.equal(isValidPermissionValue(MAX_PERMISSION_VALUE), true);
    assert.equal(isValidPermissionValue(2 ** 47), false);
    assert.equal(hasPermission(Permission.REQUEST_MANGA, permissions), true);
    assert.equal(
      hasPermission(Permission.AUTO_REQUEST_MANGA, permissions),
      true
    );
    assert.equal(
      hasPermission(Permission.AUTO_APPROVE_MANGA, permissions),
      false
    );
    assert.equal(
      hasPermission(
        [Permission.REQUEST_BOOK, Permission.REQUEST_MANGA],
        permissions,
        { type: 'and' }
      ),
      false
    );
  });

  it('auto-approve manga only for manga, general or management permissions', () => {
    const cases: [number, boolean][] = [
      [Permission.NONE, false],
      [Permission.AUTO_APPROVE_MANGA, true],
      [Permission.AUTO_APPROVE, true],
      [Permission.MANAGE_REQUESTS, true],
      [Permission.ADMIN, true],
      [Permission.AUTO_APPROVE_BOOK, false],
      [Permission.AUTO_APPROVE_COMIC, false],
      [Permission.AUTO_APPROVE_MAGAZINE, false],
      [Permission.AUTO_APPROVE_MUSIC, false],
      [Permission.AUTO_APPROVE_MOVIE + Permission.AUTO_APPROVE_TV, false],
      [Permission.REQUEST_MANGA + Permission.AUTO_REQUEST_MANGA, false],
    ];

    for (const [permissions, expected] of cases) {
      assert.equal(
        hasAutoApprovePermission(permissions, 'manga'),
        expected,
        `permissions ${permissions}`
      );
    }
  });

  it('never let the manga bit auto-approve another media type', () => {
    for (const mediaType of [
      'movie',
      'tv',
      'music',
      'book',
      'comic',
      'magazine',
    ] as const) {
      assert.equal(
        hasAutoApprovePermission(Permission.AUTO_APPROVE_MANGA, mediaType),
        false,
        mediaType
      );
    }
    assert.equal(
      hasAutoApprovePermission(Permission.AUTO_APPROVE_BOOK, 'book'),
      true
    );
  });
});
