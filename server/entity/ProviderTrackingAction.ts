import { User } from '@server/entity/User';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { DiscoveryAccountProvider } from './DiscoveryAccount';
@Entity('provider_tracking_action')
@Index('IDX_provider_tracking_action_user_request', ['userId', 'requestId'], {
  unique: true,
})
@Index('IDX_provider_tracking_action_created', ['createdAt'])
export default class ProviderTrackingAction {
  @PrimaryGeneratedColumn() public id: number;
  @Column({ type: 'int' }) public userId: number;
  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  public user: User;
  @Column({ type: 'varchar' }) public requestId: string;
  @Column({ type: 'varchar' }) public provider: DiscoveryAccountProvider;
  @Column({ type: 'varchar' }) public fingerprint: string;
  @Column({ type: 'varchar' }) public state:
    'pending' | 'succeeded' | 'unknown';
  @Column({ type: 'text' }) public intent: string;
  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;
  @DbAwareColumn({ type: 'datetime', nullable: true })
  public completedAt: Date | null;
}
