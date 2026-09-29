import DiscoveryCuratedIdentityPack from '@server/entity/DiscoveryCuratedIdentityPack';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('discovery_curated_identity_mapping')
@Index('IDX_discovery_curated_identity_mapping_identity', ['identity'], {
  unique: true,
})
@Index('IDX_discovery_curated_identity_mapping_pack_identity', [
  'packId',
  'identity',
])
export default class DiscoveryCuratedIdentityMapping {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar', length: 64 })
  public packId: string;

  @ManyToOne(() => DiscoveryCuratedIdentityPack, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'packId', referencedColumnName: 'packId' })
  public pack: DiscoveryCuratedIdentityPack;

  @Column({ type: 'varchar', length: 256 })
  public identity: string;

  @Column({ type: 'int' })
  public tmdbId: number;

  @Column({ type: 'varchar' })
  public mediaType: 'movie' | 'tv';

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public updatedAt: Date;
}
