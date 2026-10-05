import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ReaderGroupingProvider = 'grimmory' | 'bookorbit';
export type ReaderGroupingTargetType =
  'author' | 'book-series' | 'comic-series';
export type ReaderGroupingStatus = 'pending' | 'ready' | 'error';

@Entity('reader_delivery_grouping')
@Index(
  'IDX_reader_delivery_grouping_identity',
  ['provider', 'targetType', 'targetId'],
  { unique: true }
)
export default class ReaderDeliveryGrouping {
  public constructor(init?: Partial<ReaderDeliveryGrouping>) {
    Object.assign(this, init);
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar', length: 16 })
  public provider: ReaderGroupingProvider;

  @Column({ type: 'varchar', length: 16 })
  public targetType: ReaderGroupingTargetType;

  @Column({ type: 'varchar', length: 255 })
  public targetId: string;

  @Column({ type: 'varchar', length: 255 })
  public targetName: string;

  @Column({ type: 'varchar', length: 320 })
  public groupName: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  public remoteGroupId: string | null;

  @Column({ type: 'boolean', default: true })
  public isPublic: boolean;

  @Column({ type: 'boolean', default: false })
  public syncToKobo: boolean;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  public status: ReaderGroupingStatus;

  @Column({ type: 'int', default: 0 })
  public lastMatchCount: number;

  @Column({ type: 'boolean', default: false })
  public countVerified: boolean;

  @Column({ type: 'varchar', length: 512, nullable: true })
  public lastError: string | null;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastSyncedAt: Date | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({ type: 'datetime' })
  public updatedAt: Date;
}
