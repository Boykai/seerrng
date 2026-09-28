import { getRepository } from '@server/datasource';
import DiscoveryIdentityMapping from '@server/entity/DiscoveryIdentityMapping';
import { In } from 'typeorm';
import { DiscoveryIntegrationError } from './accounts';

export const MAX_PERSONAL_IDENTITY_MAPPINGS = 10_000;
const LOOKUP_BATCH_SIZE = 500;
const identityPatterns = {
  trakt: /^trakt:(?:movie|tv):(?:\d{1,20}|[A-Za-z0-9_-]{1,128})$/,
  anilist: /^anilist:\d{1,10}$/,
  simkl: /^simkl:(?:movies|shows|anime):\d{1,20}$/,
  mdblist: /^mdblist:(?:movie|tv|unknown):(?:tt\d{7,12}|\d{1,20})$/,
  plex: /^plex:(?:movie|tv):[A-Za-z0-9_-]{1,128}$/,
  jellyfin: /^jellyfin:(?:movie|tv):[0-9A-Fa-f-]{16,64}$/,
  emby: /^emby:(?:movie|tv):[0-9A-Fa-f-]{16,64}$/,
} as const;

export type PersonalIdentitySource = keyof typeof identityPatterns;

export interface IdentityMappingCandidate {
  id: string;
  title: string;
  tmdbId?: number;
  mediaType?: 'movie' | 'tv';
  identityMapped?: boolean;
}

export interface PersonalIdentityMappingPackEntry {
  identity: string;
  tmdbId: number;
  mediaType: 'movie' | 'tv';
}

export interface PersonalIdentityMappingPack {
  format: 'seerrng.personal-title-matches';
  version: 1;
  exportedAt: string;
  entries: PersonalIdentityMappingPackEntry[];
}

export function parsePersonalIdentityMappingPack(
  value: unknown
): PersonalIdentityMappingPack {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !['format', 'version', 'exportedAt', 'entries'].includes(key)
    )
  )
    throw new DiscoveryIntegrationError(
      400,
      'This title-match file is invalid.'
    );

  const pack = value as Record<string, unknown>;
  if (
    pack.format !== 'seerrng.personal-title-matches' ||
    pack.version !== 1 ||
    typeof pack.exportedAt !== 'string' ||
    !Number.isFinite(Date.parse(pack.exportedAt)) ||
    !Array.isArray(pack.entries) ||
    pack.entries.length > MAX_PERSONAL_IDENTITY_MAPPINGS
  )
    throw new DiscoveryIntegrationError(
      400,
      'This title-match file is not a supported SeerrNG pack.'
    );

  const identities = new Set<string>();
  const entries = pack.entries.map((raw): PersonalIdentityMappingPackEntry => {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).some(
        (key) => !['identity', 'tmdbId', 'mediaType'].includes(key)
      )
    )
      throw new DiscoveryIntegrationError(
        400,
        'This title-match file contains an invalid entry.'
      );
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.identity !== 'string' ||
      !Number.isSafeInteger(entry.tmdbId) ||
      Number(entry.tmdbId) < 1 ||
      Number(entry.tmdbId) > 1_000_000_000 ||
      (entry.mediaType !== 'movie' && entry.mediaType !== 'tv')
    )
      throw new DiscoveryIntegrationError(
        400,
        'This title-match file contains an invalid entry.'
      );
    parsePersonalIdentitySource(entry.identity);
    if (identities.has(entry.identity))
      throw new DiscoveryIntegrationError(
        400,
        'This title-match file repeats a provider identity.'
      );
    identities.add(entry.identity);
    return {
      identity: entry.identity,
      tmdbId: Number(entry.tmdbId),
      mediaType: entry.mediaType,
    };
  });

  return {
    format: 'seerrng.personal-title-matches',
    version: 1,
    exportedAt: pack.exportedAt,
    entries,
  };
}

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

export async function applyPersonalIdentityMappings<
  T extends IdentityMappingCandidate,
>(userId: number, items: T[]): Promise<T[]> {
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

export async function exportPersonalIdentityMappingPack(
  userId: number
): Promise<PersonalIdentityMappingPack> {
  const rows = await getRepository(DiscoveryIdentityMapping).find({
    where: { userId },
    order: { identity: 'ASC' },
  });
  return {
    format: 'seerrng.personal-title-matches',
    version: 1,
    exportedAt: new Date().toISOString(),
    entries: rows.map(({ identity, tmdbId, mediaType }) => ({
      identity,
      tmdbId,
      mediaType,
    })),
  };
}

export async function importPersonalIdentityMappingPack(
  userId: number,
  value: unknown
) {
  const pack = parsePersonalIdentityMappingPack(value);
  const repository = getRepository(DiscoveryIdentityMapping);
  return repository.manager.transaction(async (manager) => {
    const transactionRepository = manager.getRepository(
      DiscoveryIdentityMapping
    );
    const existing = new Map<string, DiscoveryIdentityMapping>();
    for (
      let offset = 0;
      offset < pack.entries.length;
      offset += LOOKUP_BATCH_SIZE
    ) {
      const rows = await transactionRepository.findBy({
        userId,
        identity: In(
          pack.entries
            .slice(offset, offset + LOOKUP_BATCH_SIZE)
            .map((entry) => entry.identity)
        ),
      });
      for (const row of rows) existing.set(row.identity, row);
    }

    const imported = pack.entries.filter(
      (entry) => !existing.has(entry.identity)
    ).length;
    const currentTotal = await transactionRepository.countBy({ userId });
    if (currentTotal + imported > MAX_PERSONAL_IDENTITY_MAPPINGS)
      throw new DiscoveryIntegrationError(
        409,
        'This account has reached its saved title-match limit.'
      );

    let updated = 0;
    let unchanged = 0;
    const writes: PersonalIdentityMappingPackEntry[] = [];
    for (const entry of pack.entries) {
      const current = existing.get(entry.identity);
      if (!current) writes.push(entry);
      else if (
        current.tmdbId !== entry.tmdbId ||
        current.mediaType !== entry.mediaType
      ) {
        updated++;
        writes.push(entry);
      } else unchanged++;
    }

    for (let offset = 0; offset < writes.length; offset += 250)
      await transactionRepository.upsert(
        writes.slice(offset, offset + 250).map((entry) => ({
          userId,
          ...entry,
          updatedAt: new Date(),
        })),
        ['userId', 'identity']
      );

    return {
      imported,
      updated,
      unchanged,
      total: pack.entries.length,
    };
  });
}
