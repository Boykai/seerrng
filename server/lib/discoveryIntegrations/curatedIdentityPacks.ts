import { getRepository } from '@server/datasource';
import DiscoveryCuratedIdentityMapping from '@server/entity/DiscoveryCuratedIdentityMapping';
import DiscoveryCuratedIdentityPack from '@server/entity/DiscoveryCuratedIdentityPack';
import { In } from 'typeorm';
import { DiscoveryIntegrationError } from './accounts';
import { parsePersonalIdentitySource } from './identityMappings';

export const MAX_CURATED_IDENTITY_PACKS = 50;
export const MAX_CURATED_IDENTITY_PACK_ENTRIES = 10_000;
export const MAX_CURATED_IDENTITY_PACK_BYTES = 5 * 1024 * 1024;
const LOOKUP_BATCH_SIZE = 500;
const packIdPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const hasControlCharacters = (value: string): boolean =>
  Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

export interface CuratedIdentityMappingPackEntry {
  identity: string;
  tmdbId: number;
  mediaType: 'movie' | 'tv';
}

export interface CuratedIdentityMappingPack {
  format: 'seerrng.curated-title-matches';
  version: 1;
  packId: string;
  name: string;
  exportedAt: string;
  entries: CuratedIdentityMappingPackEntry[];
}

export interface CuratedIdentityMappingCandidate {
  id: string;
  tmdbId?: number;
  mediaType?: 'movie' | 'tv';
  identityMapped?: boolean;
  identityResolution?: 'personal' | 'curated' | 'external-id';
}

export interface CuratedIdentityPackSummary {
  packId: string;
  name: string;
  version: number;
  count: number;
  updatedAt: string;
}

export function parseCuratedIdentityPackId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    !packIdPattern.test(value)
  )
    throw new DiscoveryIntegrationError(400, 'Choose a valid shared pack ID.');
  return value;
}

export function parseCuratedIdentityMappingPack(
  value: unknown
): CuratedIdentityMappingPack {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'format',
          'version',
          'packId',
          'name',
          'exportedAt',
          'entries',
        ].includes(key)
    )
  )
    throw new DiscoveryIntegrationError(
      400,
      'This shared title-match file is invalid.'
    );

  const rawPack = value as Record<string, unknown>;
  const packId = parseCuratedIdentityPackId(rawPack.packId);
  const name = typeof rawPack.name === 'string' ? rawPack.name.trim() : '';
  if (
    rawPack.format !== 'seerrng.curated-title-matches' ||
    rawPack.version !== 1 ||
    !name ||
    name.length > 128 ||
    hasControlCharacters(name) ||
    typeof rawPack.exportedAt !== 'string' ||
    !Number.isFinite(Date.parse(rawPack.exportedAt)) ||
    !Array.isArray(rawPack.entries) ||
    rawPack.entries.length > MAX_CURATED_IDENTITY_PACK_ENTRIES
  )
    throw new DiscoveryIntegrationError(
      400,
      'This shared title-match file is not a supported SeerrNG pack.'
    );

  const identities = new Set<string>();
  const entries = rawPack.entries.map(
    (raw): CuratedIdentityMappingPackEntry => {
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
          'This shared title-match file contains an invalid entry.'
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
          'This shared title-match file contains an invalid entry.'
        );

      parsePersonalIdentitySource(entry.identity);
      if (identities.has(entry.identity))
        throw new DiscoveryIntegrationError(
          400,
          'This shared title-match file repeats a provider identity.'
        );
      identities.add(entry.identity);
      return {
        identity: entry.identity,
        tmdbId: Number(entry.tmdbId),
        mediaType: entry.mediaType,
      };
    }
  );

  return {
    format: 'seerrng.curated-title-matches',
    version: 1,
    packId,
    name,
    exportedAt: rawPack.exportedAt,
    entries,
  };
}

export async function applyCuratedIdentityMappings<
  T extends CuratedIdentityMappingCandidate,
>(items: T[]): Promise<T[]> {
  const identities = [
    ...new Set(
      items
        .filter((item) => !item.identityMapped && !item.tmdbId)
        .map((item) => item.id)
    ),
  ];
  if (!identities.length) return items;

  const repository = getRepository(DiscoveryCuratedIdentityMapping);
  const mappings = new Map<string, DiscoveryCuratedIdentityMapping>();
  for (
    let offset = 0;
    offset < identities.length;
    offset += LOOKUP_BATCH_SIZE
  ) {
    const rows = await repository.findBy({
      identity: In(identities.slice(offset, offset + LOOKUP_BATCH_SIZE)),
    });
    for (const row of rows) mappings.set(row.identity, row);
  }

  return items.map((item) => {
    if (item.identityMapped || item.tmdbId) return item;
    const mapping = mappings.get(item.id);
    return mapping
      ? {
          ...item,
          tmdbId: mapping.tmdbId,
          mediaType: mapping.mediaType,
          identityResolution: 'curated',
        }
      : item;
  });
}

export async function listCuratedIdentityPacks(): Promise<
  CuratedIdentityPackSummary[]
> {
  const [packs, counts] = await Promise.all([
    getRepository(DiscoveryCuratedIdentityPack).find({
      order: { name: 'ASC', packId: 'ASC' },
    }),
    getRepository(DiscoveryCuratedIdentityMapping)
      .createQueryBuilder('mapping')
      .select('mapping.packId', 'packId')
      .addSelect('COUNT(mapping.id)', 'count')
      .groupBy('mapping.packId')
      .getRawMany<{ packId: string; count: string }>(),
  ]);
  const countByPackId = new Map(
    counts.map((row) => [row.packId, Number(row.count)])
  );
  return packs.map((pack) => ({
    packId: pack.packId,
    name: pack.name,
    version: pack.version,
    count: countByPackId.get(pack.packId) ?? 0,
    updatedAt: pack.updatedAt.toISOString(),
  }));
}

export async function exportCuratedIdentityPack(
  packIdValue: unknown
): Promise<CuratedIdentityMappingPack> {
  const packId = parseCuratedIdentityPackId(packIdValue);
  const pack = await getRepository(DiscoveryCuratedIdentityPack).findOneBy({
    packId,
  });
  if (!pack) throw new DiscoveryIntegrationError(404, 'Shared pack not found.');
  const entries = await getRepository(DiscoveryCuratedIdentityMapping).find({
    where: { packId },
    order: { identity: 'ASC' },
  });
  return {
    format: 'seerrng.curated-title-matches',
    version: 1,
    packId: pack.packId,
    name: pack.name,
    exportedAt: pack.updatedAt.toISOString(),
    entries: entries.map(({ identity, tmdbId, mediaType }) => ({
      identity,
      tmdbId,
      mediaType,
    })),
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const driverError = (error as { driverError?: unknown }).driverError;
  if (!driverError || typeof driverError !== 'object') return false;
  const code = (driverError as { code?: unknown }).code;
  return (
    code === '23505' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    code === 2067 ||
    code === 1555
  );
}

export async function importCuratedIdentityMappingPack(value: unknown) {
  const pack = parseCuratedIdentityMappingPack(value);
  const packs = getRepository(DiscoveryCuratedIdentityPack);

  try {
    return await packs.manager.transaction(async (manager) => {
      const packRepository = manager.getRepository(
        DiscoveryCuratedIdentityPack
      );
      const mappingRepository = manager.getRepository(
        DiscoveryCuratedIdentityMapping
      );
      const currentPack = await packRepository.findOneBy({
        packId: pack.packId,
      });
      if (
        !currentPack &&
        (await packRepository.count()) >= MAX_CURATED_IDENTITY_PACKS
      )
        throw new DiscoveryIntegrationError(
          409,
          'This SeerrNG instance has reached its shared pack limit.'
        );

      const currentEntries = await mappingRepository.findBy({
        packId: pack.packId,
      });
      const currentByIdentity = new Map(
        currentEntries.map((entry) => [entry.identity, entry])
      );
      for (
        let offset = 0;
        offset < pack.entries.length;
        offset += LOOKUP_BATCH_SIZE
      ) {
        const rows = await mappingRepository.findBy({
          identity: In(
            pack.entries
              .slice(offset, offset + LOOKUP_BATCH_SIZE)
              .map((entry) => entry.identity)
          ),
        });
        const conflict = rows.find((row) => row.packId !== pack.packId);
        if (conflict)
          throw new DiscoveryIntegrationError(
            409,
            `Provider identity is already assigned to shared pack "${conflict.packId}".`
          );
      }

      let imported = 0;
      let updated = 0;
      let unchanged = 0;
      const inputIdentities = new Set(
        pack.entries.map((entry) => entry.identity)
      );
      for (const entry of pack.entries) {
        const previous = currentByIdentity.get(entry.identity);
        if (!previous) imported += 1;
        else if (
          previous.tmdbId !== entry.tmdbId ||
          previous.mediaType !== entry.mediaType
        )
          updated += 1;
        else unchanged += 1;
      }
      const removed = currentEntries.filter(
        (entry) => !inputIdentities.has(entry.identity)
      ).length;
      const updatedAt = new Date();
      await packRepository.save(
        packRepository.create({
          packId: pack.packId,
          name: pack.name,
          version: pack.version,
          updatedAt,
        })
      );
      await mappingRepository.delete({ packId: pack.packId });
      for (
        let offset = 0;
        offset < pack.entries.length;
        offset += LOOKUP_BATCH_SIZE
      ) {
        await mappingRepository.insert(
          pack.entries
            .slice(offset, offset + LOOKUP_BATCH_SIZE)
            .map((entry) => ({ ...entry, packId: pack.packId, updatedAt }))
        );
      }
      return {
        packId: pack.packId,
        name: pack.name,
        imported,
        updated,
        unchanged,
        removed,
        total: pack.entries.length,
      };
    });
  } catch (error) {
    if (isUniqueConstraintError(error))
      throw new DiscoveryIntegrationError(
        409,
        'Another shared pack changed while this pack was being saved. Reload the pack list and try again.'
      );
    throw error;
  }
}

export async function removeCuratedIdentityPack(packIdValue: unknown) {
  const packId = parseCuratedIdentityPackId(packIdValue);
  return getRepository(DiscoveryCuratedIdentityPack).manager.transaction(
    async (manager) => {
      const packRepository = manager.getRepository(
        DiscoveryCuratedIdentityPack
      );
      if (!(await packRepository.findOneBy({ packId })))
        throw new DiscoveryIntegrationError(404, 'Shared pack not found.');
      await manager
        .getRepository(DiscoveryCuratedIdentityMapping)
        .delete({ packId });
      await packRepository.delete({ packId });
      return { removed: true };
    }
  );
}
