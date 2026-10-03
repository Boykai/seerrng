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

/** Which chapters a manga request asks for. */
export enum MangaRequestScope {
  /** Every chapter the source lists when the request is dispatched. */
  ALL_AT_DISPATCH = 'ALL_AT_DISPATCH',
  /** The chapters with the N highest chapter numbers. */
  LATEST_N = 'LATEST_N',
  /** The chapters numbered from `rangeStart` to `rangeEnd`, inclusive. */
  RANGE = 'RANGE',
}

/**
 * Whether the request's title has an ACTIVE source binding on its target
 * instance. A hint kept in step with the bindings; dispatch re-verifies it.
 */
export enum MangaRequestBindingState {
  /** Parked: no ACTIVE binding exists yet on the target instance. */
  AWAITING_BINDING = 'AWAITING_BINDING',
  BOUND = 'BOUND',
}

/** Dispatch steps, in order. Each names the last step completed. */
export enum MangaRequestCheckpoint {
  BINDING_VERIFIED = 'BINDING_VERIFIED',
  INSTANCE_MARKED = 'INSTANCE_MARKED',
  LIBRARY_ADDED = 'LIBRARY_ADDED',
  CATEGORY_READY = 'CATEGORY_READY',
  CHAPTERS_FETCHED = 'CHAPTERS_FETCHED',
  MANIFEST_FROZEN = 'MANIFEST_FROZEN',
  CHAPTERS_ENQUEUED = 'CHAPTERS_ENQUEUED',
}

/** What one manga request asks for, and how far its dispatch has got. */
@Entity('manga_request_manifest')
@Unique('UQ_manga_request_manifest_request', ['requestId'])
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
