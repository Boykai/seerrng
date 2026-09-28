import { getRepository } from '@server/datasource';
import DiscoveryIdentityMapping from '@server/entity/DiscoveryIdentityMapping';
import type { PersonalLibraryItem } from '@server/lib/discoveryIntegrations/library';
import { In } from 'typeorm';
import { DiscoveryIntegrationError } from './accounts';

export const MAX_PERSONAL_IDENTITY_MAPPINGS = 10_000;
const LOOKUP_BATCH_SIZE = 500;
const identityPatterns = {
  trakt: /^trakt:(?:movie|tv):\d{1,20}$/,
  anilist: /^anilist:\d{1,10}$/,
  simkl: /^simkl:(?:movies|shows|anime):\d{1,20}$/,
  plex: /^plex:(?:movie|tv):[A-Za-z0-9_-]{1,128}$/,
  jellyfin: /^jellyfin:(?:movie|tv):[0-9A-Fa-f-]{16,64}$/,
  emby: /^emby:(?:movie|tv):[0-9A-Fa-f-]{16,64}$/,
} as const;

export type PersonalIdentitySource = keyof typeof identityPatterns;

export function parsePersonalIdentitySource(
  value: unknown
): PersonalIdentitySource {
  if (typeof value !== 'string' || value.length > 256)
    throw new DiscoveryIntegrationError(400, 'Choose a valid library title.');
  const source = value.slice(0, value.indexOf(':')) as PersonalIdentitySource;
  const pattern = identityPatterns[source];
  if (!pattern || !pattern.test(value))
    throw new DiscoveryIntegrationError(400, 'Choose a valid library title.');
  return source;
}

export async function applyPersonalIdentityMappings(
  userId: number,
  items: PersonalLibraryItem[]
): Promise<PersonalLibraryItem[]> {
  const identities = [...new Set(items.map((item) => item.id))];
  if (!identities.length) return items;
  const repository = getRepository(DiscoveryIdentityMapping);
  const mappings = new Map<string, DiscoveryIdentityMapping>();
  for (
    let offset = 0;
    offset < identities.length;
    offset += LOOKUP_BATCH_SIZE
  ) {
    const rows = await repository.findBy({
      userId,
      identity: In(identities.slice(offset, offset + LOOKUP_BATCH_SIZE)),
    });
    for (const row of rows) mappings.set(row.identity, row);
  }
  return items.map((item) => {
    const mapping = mappings.get(item.id);
    return mapping
      ? {
          ...item,
          tmdbId: mapping.tmdbId,
          mediaType: mapping.mediaType,
          identityMapped: true,
        }
      : item;
  });
}

export async function savePersonalIdentityMapping(
  userId: number,
  identity: string,
  tmdbId: number,
  mediaType: 'movie' | 'tv'
) {
  parsePersonalIdentitySource(identity);
  if (
    !Number.isSafeInteger(userId) ||
    userId < 1 ||
    !Number.isSafeInteger(tmdbId) ||
    tmdbId < 1 ||
    tmdbId > 1_000_000_000 ||
    (mediaType !== 'movie' && mediaType !== 'tv')
  )
    throw new DiscoveryIntegrationError(400, 'Choose a valid catalog match.');

  const repository = getRepository(DiscoveryIdentityMapping);
  const current = await repository.findOneBy({ userId, identity });
  if (
    !current &&
    (await repository.countBy({ userId })) >= MAX_PERSONAL_IDENTITY_MAPPINGS
  )
    throw new DiscoveryIntegrationError(
      409,
      'This account has reached its saved title-match limit.'
    );

  await repository.upsert(
    { userId, identity, tmdbId, mediaType, updatedAt: new Date() },
    ['userId', 'identity']
  );
  const saved = await repository.findOneBy({ userId, identity });
  if (!saved)
    throw new DiscoveryIntegrationError(
      500,
      'The title match could not be saved.'
    );
  return {
    identity: saved.identity,
    tmdbId: saved.tmdbId,
    mediaType: saved.mediaType,
    updatedAt: saved.updatedAt,
  };
}

export async function removePersonalIdentityMapping(
  userId: number,
  identity: string
) {
  parsePersonalIdentitySource(identity);
  const result = await getRepository(DiscoveryIdentityMapping).delete({
    userId,
    identity,
  });
  return { removed: (result.affected ?? 0) > 0 };
}
