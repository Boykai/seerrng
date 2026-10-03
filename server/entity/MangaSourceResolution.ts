import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Where the source resolver stands with a requested title on an instance. */
export enum MangaResolutionStatus {
  /** Waiting for the resolver's next run. */
  QUEUED = 'QUEUED',
  /** Candidates wait for an admin; nothing was bound. */
  NEEDS_PICK = 'NEEDS_PICK',
  NO_MATCH = 'NO_MATCH',
  /** The content policy excludes the title, or AniList no longer knows it. */
  EXCLUDED = 'EXCLUDED',
  BOUND = 'BOUND',
}

/**
 * The source resolver's state for one requested title on one Suwayomi
 * instance. Holds stable codes only, never titles, queries or URLs.
 */
@Entity()
@Index('UQ_manga_source_resolution_title', ['instanceId', 'anilistId'], {
  unique: true,
})
class MangaSourceResolution {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'integer' })
  public instanceId: number;

  @Column({ type: 'integer' })
  public anilistId: number;

  @Column({
    type: 'varchar',
    length: 16,
    default: MangaResolutionStatus.QUEUED,
  })
  public status: MangaResolutionStatus;

  /** Why the title has its status, as a stable code. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  public reason: string | null;

  /** The MangaDex UUID linked to the title, when MangaDex links one or more. */
  @Column({ type: 'varchar', length: 36, nullable: true })
  public mangadexUuid: string | null;

  /** An admin asked for a search; cleared once a run has searched. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public searchRequestedAt: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public checkedAt: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public searchedAt: Date | null;

  /** Runs in a row that found nothing, or that no source answered. */
  @Column({ type: 'integer', default: 0 })
  public attempts: number;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public nextAttemptAt: Date | null;

  /** A stable failure code, never free text. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  public lastError: string | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<MangaSourceResolution>) {
    Object.assign(this, init);
  }
}

export default MangaSourceResolution;
