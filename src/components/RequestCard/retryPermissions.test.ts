import { describe, expect, it } from 'vitest';

import { Permission } from '@server/lib/permissions';
import { canRetryRequest } from './retryPermissions';

describe('canRetryRequest', () => {
  it('allows an owner with permission to request that media type', () => {
    expect(
      canRetryRequest({
        requestType: 'book',
        is4k: false,
        requestedById: 12,
        userId: 12,
        permissions: Permission.REQUEST_BOOK,
      })
    ).toBe(true);
  });

  it('allows an owner with the general request permission', () => {
    expect(
      canRetryRequest({
        requestType: 'book',
        is4k: false,
        requestedById: 12,
        userId: 12,
        permissions: Permission.REQUEST,
      })
    ).toBe(true);
  });

  it('uses the 4K request permissions for 4K movie requests', () => {
    expect(
      canRetryRequest({
        requestType: 'movie',
        is4k: true,
        requestedById: 12,
        userId: 12,
        permissions: Permission.REQUEST_MOVIE,
      })
    ).toBe(false);
    expect(
      canRetryRequest({
        requestType: 'movie',
        is4k: true,
        requestedById: 12,
        userId: 12,
        permissions: Permission.REQUEST_4K_MOVIE,
      })
    ).toBe(true);
  });

  it('does not allow another requester or a user without request rights', () => {
    expect(
      canRetryRequest({
        requestType: 'book',
        is4k: false,
        requestedById: 12,
        userId: 13,
        permissions: Permission.REQUEST_BOOK,
      })
    ).toBe(false);
    expect(
      canRetryRequest({
        requestType: 'book',
        is4k: false,
        requestedById: 12,
        userId: 12,
        permissions: Permission.NONE,
      })
    ).toBe(false);
  });

  it('allows request managers to retry requests they do not own', () => {
    expect(
      canRetryRequest({
        requestType: 'comic',
        is4k: false,
        requestedById: 12,
        userId: 13,
        permissions: Permission.MANAGE_REQUESTS,
      })
    ).toBe(true);
  });

  it('requires a manga request permission to retry manga requests', () => {
    const retryManga = (permissions: number) =>
      canRetryRequest({
        requestType: 'manga',
        is4k: false,
        requestedById: 12,
        userId: 12,
        permissions,
      });

    expect(retryManga(Permission.REQUEST_MANGA)).toBe(true);
    expect(retryManga(Permission.REQUEST)).toBe(true);
    expect(
      retryManga(
        Permission.REQUEST_BOOK +
          Permission.REQUEST_COMIC +
          Permission.REQUEST_MAGAZINE
      )
    ).toBe(false);
  });
});
