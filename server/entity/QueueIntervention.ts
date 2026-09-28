import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { DownloadRecoveryServiceType } from './DownloadRecoveryState';

export type InterventionState =
  'active' | 'importing' | 'rejecting' | 'resolved' | 'failed';
@Entity('queue_intervention')
@Index('IDX_queue_intervention_identity', ['identity'], { unique: true })
@Index('IDX_queue_intervention_state_seen', ['state', 'lastSeenAt'])
export default class QueueIntervention {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'varchar' }) public identity: string;
  @Column({ type: 'varchar' }) public authority: string;
  @Column({ type: 'varchar' }) public serviceType: DownloadRecoveryServiceType;
  @Column({ type: 'int' }) public serviceId: number;
  @Column({ type: 'varchar' }) public serviceName: string;
  @Column({ type: 'int' }) public queueId: number;
  @Column({ type: 'varchar', nullable: true, select: false })
  public downloadId: string | null;
  @Column({ type: 'varchar' }) public title: string;
  @Column({ type: 'text' }) public warnings: string;
  @Column({ type: 'text', default: '[]' }) public actions: string;
  @Column({ type: 'varchar', default: 'active' })
  public state: InterventionState;
  @Column({ type: 'varchar', nullable: true }) public resolution: string | null;
  @Column({ type: 'int', nullable: true }) public actorId: number | null;
  @Column({ type: 'int', nullable: true }) public commandId: number | null;
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public lastSeenAt: Date;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public actionAt: Date | null;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public resolvedAt: Date | null;
}
