import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyDiscoverStateOverlay,
  getDiscoverOverlayRequestKey,
  getDiscoverStateInputs,
} from './discoverStateOverlay';

describe('Discover state overlays', () => {
  it('partitions applied revisions by user context and catalog inputs', () => {
    const inputs = [{ mediaType: MediaType.MOVIE, id: 1 }];
    const first = getDiscoverOverlayRequestKey('user:1', 'revision', inputs);

    assert.notEqual(
      first,
      getDiscoverOverlayRequestKey('user:2', 'revision', inputs)
    );
    assert.notEqual(
      first,
      getDiscoverOverlayRequestKey('user:1', 'revision', [
        ...inputs,
        { mediaType: MediaType.TV, id: 2 },
      ])
    );
  });

  it('collects and deduplicates supported catalog identifiers', () => {
    const inputs = getDiscoverStateInputs([
      {
        results: [
          { id: 1, mediaType: 'movie' },
          { id: 1, mediaType: 'movie' },
          { id: 'release-group', mediaType: 'album' },
          { id: 4, mediaType: 'person' },
        ],
      },
    ]);

    assert.deepEqual(inputs, [
      { mediaType: MediaType.MOVIE, id: 1 },
      { mediaType: MediaType.MUSIC, id: 'release-group' },
    ]);
  });

  it('updates personalized state without changing catalog ordering', () => {
    const pages: {
      page: number;
      results: {
        id: number;
        mediaType: string;
        title: string;
        mediaInfo?: Record<string, unknown>;
      }[];
    }[] = [
      {
        page: 1,
        results: [
          { id: 1, mediaType: 'movie', title: 'First' },
          { id: 2, mediaType: 'movie', title: 'Second' },
        ],
      },
    ];
    const updated = applyDiscoverStateOverlay(pages, {
      revision: 'state-revision',
      generatedAt: new Date(0).toISOString(),
      items: [
        {
          key: `${MediaType.MOVIE}:1`,
          mediaType: MediaType.MOVIE,
          id: 1,
          media: {
            id: 10,
            status: MediaStatus.PROCESSING,
            status4k: MediaStatus.UNKNOWN,
            updatedAt: new Date(0).toISOString(),
          },
          request: {
            id: 20,
            status: MediaRequestStatus.APPROVED,
            is4k: false,
            updatedAt: new Date(0).toISOString(),
          },
          watchlisted: true,
        },
      ],
    });

    assert.deepEqual(
      updated[0].results.map((item) => item.title),
      ['First', 'Second']
    );
    assert.equal(
      updated[0].results[0].mediaInfo?.status,
      MediaStatus.PROCESSING
    );
    assert.equal(
      (updated[0].results[0].mediaInfo?.watchlists as unknown[]).length,
      1
    );
    assert.equal(updated[0].results[1], pages[0].results[1]);
  });

  it('sends manga by its AniList id string and applies its state', () => {
    const pages = [
      {
        results: [
          { id: 30013, mediaType: 'manga', title: 'Manga' },
          { id: 30013, mediaType: 'manga', title: 'Manga' },
          { id: 30013, mediaType: 'movie', title: 'Movie' },
        ],
      },
    ];

    assert.deepEqual(getDiscoverStateInputs(pages), [
      { mediaType: MediaType.MANGA, id: '30013' },
      { mediaType: MediaType.MOVIE, id: 30013 },
    ]);

    const updated = applyDiscoverStateOverlay(pages, {
      revision: 'state-revision',
      generatedAt: new Date(0).toISOString(),
      items: [
        {
          key: `${MediaType.MANGA}:30013`,
          mediaType: MediaType.MANGA,
          id: '30013',
          media: {
            id: 11,
            status: MediaStatus.BLOCKLISTED,
            status4k: MediaStatus.UNKNOWN,
            updatedAt: new Date(0).toISOString(),
          },
          request: null,
          watchlisted: false,
        },
      ],
    });

    assert.equal(
      (updated[0].results[0] as { mediaInfo?: { status?: MediaStatus } })
        .mediaInfo?.status,
      MediaStatus.BLOCKLISTED
    );
    assert.equal(updated[0].results[2], pages[0].results[2]);
  });
});
