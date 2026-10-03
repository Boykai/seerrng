import {
  MangaRequestBindingState,
  MangaRequestScope,
  type MangaRequestCheckpoint,
} from '@server/constants/mangaRequest';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { MediaRequest } from './MediaRequest';

/** What one manga request asks for, and how far its dispatch has got. */
@Entity('manga_request_manifest')
@Unique('UQ_manga_request_manifest_request', ['requestId'])
@Index('IDX_manga_request_manifest_binding', [
  'instanceId',
  'bindingSourceId',
  'bindingUrlHash',
])
@Index('IDX_manga_request_manifest_follow_due', [
  'followEnabled',
  'followNextAt',
])
export class MangaRequestManifest {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'integer' })
  public requestId: number;

  @OneToOne(() => MediaRequest, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'requestId',
    foreignKeyConstraintName: 'FK_manga_request_manifest_request',
  })
  public request: MediaRequest;

  @Index('IDX_manga_request_manifest_anilistId')
  @Column({ type: 'integer' })
  public anilistId: number;

  /** The Suwayomi instance (settings ID) the request targets. */
  @Index('IDX_manga_request_manifest_instanceId')
  @Column({ type: 'integer' })
  public instanceId: number;

  @Column({
    type: 'varchar',
    length: 16,
    default: MangaRequestScope.ALL_AT_DISPATCH,
  })
  public scope: MangaRequestScope;

  @Column({ type: 'integer', nullable: true })
  public latestCount: number | null;

  @Column({ type: 'double precision', nullable: true })
  public rangeStart: number | null;

  @Column({ type: 'double precision', nullable: true })
  public rangeEnd: number | null;

  @Column({
    type: 'varchar',
    length: 32,
    default: MangaRequestBindingState.AWAITING_BINDING,
  })
  public bindingState: MangaRequestBindingState;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public boundAt: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  public checkpoint: MangaRequestCheckpoint | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public checkpointAt: Date | null;

  @Column({ type: 'integer', default: 0 })
  public attempts: number;

  /** A stable failure code, never free text. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  public lastError: string | null;

  /** Set once the chapter rows are written; the scope is fixed from then on. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public frozenAt: Date | null;

  /** The bound source manga's source; fixed once the scope is frozen. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  public bindingSourceId: string | null;

  /** SHA-256 of the bound source manga's URL. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  public bindingUrlHash: string | null;

  /** The Suwayomi manga ID last resolved: a cache, resolved again each run. */
  @Column({ type: 'integer', nullable: true })
  public suwayomiMangaId: number | null;

  /** The dispatch sweep leaves the request alone until then. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public retryNotBefore: Date | null;

  /** A `MangaAttentionCode` the progress poll raised; never free text. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  public attentionCode: string | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public attentionAt: Date | null;

  /** The last progress poll that looked at the manifest. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public progressAt: Date | null;

  /** What the manga looked like at the last chapter read, hashed. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  public progressSignature: string | null;

  @Column({ type: 'integer', default: 0 })
  public chaptersTotal: number;

  /** Chapters whose file a HEAD request found non-empty. */
  @Column({ type: 'integer', default: 0 })
  public chaptersVerified: number;

  @Column({ type: 'integer', default: 0 })
  public chaptersQueued: number;

  @Column({ type: 'integer', default: 0 })
  public chaptersDownloading: number;

  @Column({ type: 'integer', default: 0 })
  public chaptersErrored: number;

  @Column({ type: 'integer', default: 0 })
  public chaptersMissing: number;

  /** The owner's consent to add chapters the source publishes later. */
  @Column({ type: 'boolean', default: false })
  public followEnabled: boolean;

  /** When the follow job checks the source again; null means now. */
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public followNextAt: Date | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public followLastAt: Date | null;

  /** A `MangaFollowStopReason`; never free text. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  public followStopReason: string | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<MangaRequestManifest>) {
    Object.assign(this, init);
  }
}

export default MangaRequestManifest;
