import {
  MUSIC_RELEASE_TYPES,
  musicReleaseTypeField,
} from '@server/constants/musicReleaseTypes';
import { toMusicAlbumRefinementQuery } from './searchTerms';
import { parseOptionalBoundedString } from './validation';

export const buildArtistAutocompleteQuery = (input: string): string =>
  input
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 16)
    .map(
      (term) =>
        `artist:${term.replace(/(&&|\|\||[+\-!(){}[\]^"~*?:\\/])/g, '\\$1')}*`
    )
    .join(' AND ');

export interface MusicSearchFilters {
  artist?: string;
  artistId?: string;
  genre?: string;
  releaseType?: string;
  primaryReleaseDateGte?: string;
  primaryReleaseDateLte?: string;
}

export const parseMusicSearchFilters = (
  query: Record<string, unknown>
): { value: MusicSearchFilters } | { error: string } => {
  const filters: MusicSearchFilters = {};
  for (const key of [
    'artist',
    'artistId',
    'genre',
    'releaseType',
    'primaryReleaseDateGte',
    'primaryReleaseDateLte',
  ] as const) {
    const parsed = parseOptionalBoundedString(query[key], {
      fieldName:
        key === 'primaryReleaseDateGte'
          ? 'Primary release date start'
          : key === 'primaryReleaseDateLte'
            ? 'Primary release date end'
            : key,
      maxLength: key.startsWith('primary') ? 10 : 256,
    });
    if ('error' in parsed) return parsed;
    const value = parsed.value?.trim();
    if (!value) continue;
    if (
      key === 'releaseType' &&
      value
        .split(',')
        .some(
          (type) =>
            !MUSIC_RELEASE_TYPES.some(
              (known) => known.toLowerCase() === type.trim().toLowerCase()
            )
        )
    )
      return {
        error: 'Release type must be a supported MusicBrainz release type.',
      };
    if (
      key === 'artistId' &&
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
    )
      return { error: 'Artist ID must be a valid MusicBrainz identifier.' };
    if (key.startsWith('primary')) {
      const date = new Date(value);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value
      )
        return { error: `${key} must be a valid YYYY-MM-DD date.` };
    }
    filters[key] = value;
  }
  if (
    filters.primaryReleaseDateGte &&
    filters.primaryReleaseDateLte &&
    filters.primaryReleaseDateGte > filters.primaryReleaseDateLte
  )
    return { error: 'Release date start must not be after release date end.' };
  return { value: filters };
};

const quote = (value: string) =>
  `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** All constraints reach MusicBrainz before pagination, not just the loaded cards. */
export const buildMusicAlbumSearchQuery = (
  query: string,
  filters: MusicSearchFilters,
  albumTitle = ''
): string => {
  const terms = [toMusicAlbumRefinementQuery(query, albumTitle)];
  if (filters.artistId) terms.push(`arid:${quote(filters.artistId)}`);
  else if (filters.artist) terms.push(`artist:${quote(filters.artist)}`);
  for (const [field, value] of [
    ['tag', filters.genre],
    ['releaseType', filters.releaseType],
  ] as const) {
    const choices =
      value
        ?.split(',')
        .map((v) => v.trim())
        .filter(Boolean) ?? [];
    if (choices.length)
      terms.push(
        `(${choices.map((v) => `${field === 'releaseType' ? musicReleaseTypeField(v) : field}:${quote(v)}`).join(' OR ')})`
      );
  }
  if (filters.primaryReleaseDateGte || filters.primaryReleaseDateLte)
    terms.push(
      `firstreleasedate:[${filters.primaryReleaseDateGte ?? '*'} TO ${filters.primaryReleaseDateLte ?? '*'}]`
    );
  return terms.filter(Boolean).join(' AND ');
};
