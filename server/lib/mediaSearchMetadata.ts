import { getRepository } from '@server/datasource';
import { MediaSearchMetadata } from '@server/entity/MediaSearchMetadata';
import logger from '@server/logger';

export type MediaSearchMetadataInput = Partial<
  Pick<
    MediaSearchMetadata,
    | 'title'
    | 'overview'
    | 'posterPath'
    | 'alternateTitle'
    | 'releaseDate'
    | 'genres'
    | 'runtime'
    | 'creator'
    | 'director'
    | 'writer'
    | 'studio'
    | 'network'
    | 'artist'
    | 'albumType'
    | 'author'
    | 'publisher'
    | 'format'
    | 'provider'
    | 'externalIds'
  >
>;

const MAX_FIELD_LENGTH = 4_000;

const clean = (value: unknown): string | undefined => {
  if (Array.isArray(value)) {
    return clean(value.filter(Boolean).join(', '));
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, MAX_FIELD_LENGTH) : undefined;
};

const searchableFields: (keyof MediaSearchMetadataInput)[] = [
  'title',
  'alternateTitle',
  'releaseDate',
  'genres',
  'runtime',
  'creator',
  'director',
  'writer',
  'studio',
  'network',
  'artist',
  'albumType',
  'author',
  'publisher',
  'format',
  'provider',
  'externalIds',
];

export const upsertMediaSearchMetadata = async (
  mediaId: number | undefined,
  input: MediaSearchMetadataInput
): Promise<void> => {
  if (!mediaId) {
    return;
  }

  try {
    const repository = getRepository(MediaSearchMetadata);
    const existing = await repository.findOne({ where: { mediaId } });
    const next = existing ?? repository.create({ mediaId, searchText: '' });

    const overview = clean(input.overview);
    if (overview) {
      next.overview = overview;
    }

    const posterPath = clean(input.posterPath);
    if (posterPath) {
      next.posterPath = posterPath;
    }

    for (const field of searchableFields) {
      const value = clean(input[field]);
      if (value) {
        Object.assign(next, { [field]: value });
      }
    }

    next.searchText = searchableFields
      .map((field) => next[field])
      .filter((value): value is string => typeof value === 'string' && !!value)
      .join(' ')
      .toLocaleLowerCase();

    await repository.save(next);
  } catch (error) {
    logger.warn('Unable to refresh searchable media metadata', {
      label: 'Metadata Search',
      mediaId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
};
