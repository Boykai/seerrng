import type { CuratedCollectionMember } from '@server/models/CuratedCollection';
import { expect, it } from 'vitest';
import {
  curatedPlaybackIds,
  reconcileCuratedSelection,
} from './curatedCollectionSelection';
import {
  EMPTY_MUSIC_COLLECTION_FILTERS,
  filterMusicCollection,
  musicCollectionFilterOptions,
  musicCollectionTypeLabel,
} from './musicCollectionFilters';

const parts = [
  {
    id: 'studio',
    title: 'Studio',
    releaseDate: '1998-02-23',
    primaryType: 'Album',
    secondaryTypes: [],
    genres: ['pop'],
    mediaInfo: { id: 1, ratingKeyMp3: '1' },
  },
  {
    id: 'live',
    title: 'Live',
    releaseDate: '2000',
    primaryType: 'Album',
    secondaryTypes: ['Live', 'Compilation'],
    genres: ['Pop', 'rock'],
    mediaInfo: { id: 2, ratingKeyMp3: '2' },
  },
  {
    id: 'remix',
    title: 'Remix',
    releaseDate: '',
    primaryType: 'Album',
    secondaryTypes: ['Remix'],
    genres: ['dance'],
  },
] as CuratedCollectionMember[];
it('matches primary and secondary types, genres and years together', () => {
  expect(
    filterMusicCollection(parts, {
      releaseType: 'Live',
      genre: 'pop',
      year: '2000',
    }).map((p) => p.id)
  ).toEqual(['live']);
  expect(
    filterMusicCollection(parts, {
      ...EMPTY_MUSIC_COLLECTION_FILTERS,
      releaseType: 'Album',
    }).map((p) => p.id)
  ).toEqual(['studio']);
  expect(
    filterMusicCollection(parts, {
      ...EMPTY_MUSIC_COLLECTION_FILTERS,
      releaseType: 'Compilation',
    }).map((p) => p.id)
  ).toEqual(['live']);
  expect(
    filterMusicCollection(parts, {
      releaseType: 'Compilation',
      genre: 'dance',
      year: '',
    })
  ).toEqual([]);
  expect(
    filterMusicCollection(parts, {
      ...EMPTY_MUSIC_COLLECTION_FILTERS,
      year: 'unknown',
    }).map((p) => p.id)
  ).toEqual(['remix']);
});
it('derives stable genre/year choices from the whole collection, not the displayed subset', () => {
  const options = musicCollectionFilterOptions(parts);
  expect(options.genres.map((p) => p.value)).toEqual(['dance', 'pop', 'rock']);
  expect(options.years.map((p) => p.value)).toEqual(['2000', '1998']);
  expect(options.unknownYear).toBe(true);
});
it('shows Album only for plain albums and names secondary types without that base type', () => {
  expect(musicCollectionTypeLabel(parts[0])).toBe('Album');
  expect(musicCollectionTypeLabel(parts[1])).toBe('Live · Compilation');
  expect(musicCollectionTypeLabel(parts[2])).toBe('Remix');
});
it('drops hidden selections and does not restore them when clearing filters', () => {
  const shown = filterMusicCollection(parts, {
    ...EMPTY_MUSIC_COLLECTION_FILTERS,
    releaseType: 'Live',
  });
  const selected = reconcileCuratedSelection(
    shown.map((p) => p.id),
    parts.map((p) => p.id),
    true
  );
  expect(selected).toEqual(['live']);
  expect(curatedPlaybackIds(shown, selected, 'music', false)).toEqual([2]);
  expect(
    reconcileCuratedSelection(
      parts.map((p) => p.id),
      selected,
      true
    )
  ).toEqual(['live']);
});
it('supports cached collection data while structured types are being refreshed', () => {
  const cached = {
    ...parts[1],
    primaryType: undefined,
    secondaryTypes: undefined,
    subtitle: 'Album · Live · Compilation',
  };
  expect(
    filterMusicCollection([cached], {
      ...EMPTY_MUSIC_COLLECTION_FILTERS,
      releaseType: 'Live',
    })
  ).toHaveLength(1);
  expect(
    filterMusicCollection([cached], {
      ...EMPTY_MUSIC_COLLECTION_FILTERS,
      releaseType: 'Album',
    })
  ).toEqual([]);
  expect(musicCollectionTypeLabel(cached)).toBe('Live · Compilation');
});
