import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('discovery_curated_identity_pack')
export default class DiscoveryCuratedIdentityPack {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  public packId: string;

  @Column({ type: 'varchar', length: 128 })
  public name: string;

  @Column({ type: 'int' })
  public version: number;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public updatedAt: Date;
}
