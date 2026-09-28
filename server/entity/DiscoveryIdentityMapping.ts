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

@Entity('discovery_identity_mapping')
@Index('IDX_discovery_identity_mapping_user_identity', ['userId', 'identity'], {
  unique: true,
})
@Index('IDX_discovery_identity_mapping_user_updated', ['userId', 'updatedAt'])
export default class DiscoveryIdentityMapping {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'int' })
  public userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  public user: User;

  @Column({ type: 'varchar', length: 256 })
  public identity: string;

  @Column({ type: 'int' })
  public tmdbId: number;

  @Column({ type: 'varchar' })
  public mediaType: 'movie' | 'tv';

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public updatedAt: Date;
}
