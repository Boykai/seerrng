import { MediaStatus } from '@server/constants/media';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import { createHash } from 'node:crypto';
import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** How sure the link is. Exact and tracker links are never second-guessed. */
export enum MangaBindingConfidence {
  EXACT_LINK = 'EXACT_LINK',
  TRACKER_LINK = 'TRACKER_LINK',
  MANUAL = 'MANUAL',
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
}

export enum MangaBindingState {
  ACTIVE = 'ACTIVE',
  /** The item left the library, or its Suwayomi instance was removed. */
  ORPHANED = 'ORPHANED',
  /** An admin refused this pair; it is never proposed again. */
  REJECTED = 'REJECTED',
}

export const MANGA_BINDING_ORIGIN_LIBRARY_SCAN = 'library-scan';
export const MANGA_MATCHED_BY_ANILIST_TRACKER = 'anilist-tracker';
export const MANGA_MATCHED_BY_MAL_TRACKER = 'mal-tracker';
export const MANGA_MATCHED_BY_MANGADEX_LINK = 'mangadex-link';

/** The `urlHash` of bindings and candidates: SHA-256 of the URL, in hex. */
export const hashMangaSourceUrl = (url: string): string =>
  createHash('sha256').update(url).digest('hex');

/** Live states; at most one live binding exists per source manga. */
export const MANGA_LIVE_BINDING_STATES = [
  MangaBindingState.ACTIVE,
  MangaBindingState.ORPHANED,
] as const;

/**
 * One decision about a (source manga, AniList ID) pair on one Suwayomi
 * instance. The source manga is its natural key, `(sourceId, url)`; the
 * Suwayomi manga ID is only a cache, since a backup restore can renumber it.
 */
@Entity()
@Index('UQ_manga_source_binding_live', ['instanceId', 'sourceId', 'urlHash'], {
  unique: true,
  where: `"state" IN ('ACTIVE', 'ORPHANED')`,
})
@Index(
  'UQ_manga_source_binding_pair',
  ['instanceId', 'sourceId', 'urlHash', 'anilistId'],
  { unique: true }
)
class MangaSourceBinding {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'integer' })
  public instanceId: number;

  @Column({ type: 'varchar', length: 32 })
  public sourceId: string;

  /** Source-relative URL, never the resolved web address. */
  @Column({ type: 'varchar', length: 2048 })
  public url: string;

  /** SHA-256 of `url`, which keeps the unique keys within index size limits. */
  @Column({ type: 'varchar', length: 64 })
  public urlHash: string;

  @Column({ type: 'integer', nullable: true })
  public suwayomiMangaId: number | null;

  @Index('IDX_manga_source_binding_anilistId')
  @Column({ type: 'integer' })
  public anilistId: number;

  @Column({ type: 'varchar', length: 16 })
  public confidence: MangaBindingConfidence;

  @Column({ type: 'varchar', length: 32 })
  public matchedBy: string;

  @Column({ type: 'varchar', length: 16 })
  public origin: string;

  @Column({ type: 'varchar', length: 16 })
  public state: MangaBindingState;

  /** True when the latest complete listing contained the item. */
  @Column({ type: 'boolean', default: false })
  public inLibrary: boolean;

  @Column({ type: 'integer', nullable: true })
  public chapterCount: number | null;

  @Column({ type: 'integer', nullable: true })
  public downloadCount: number | null;

  /** UNKNOWN (in library only), PARTIALLY_AVAILABLE or AVAILABLE. */
  @Column({ type: 'integer', default: MediaStatus.UNKNOWN })
  public availability: MediaStatus;

  @Column({ type: 'varchar', length: 512, nullable: true })
  public title: string | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<MangaSourceBinding>) {
    Object.assign(this, init);
  }
}

export default MangaSourceBinding;
