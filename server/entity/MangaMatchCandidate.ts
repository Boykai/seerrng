import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * An in-library source manga with no live binding, kept for admin review.
 * The scan deletes it once the item is bound, leaves the library or loses its
 * instance.
 */
@Entity()
@Index('UQ_manga_match_candidate_item', ['instanceId', 'sourceId', 'urlHash'], {
  unique: true,
})
class MangaMatchCandidate {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'integer' })
  public instanceId: number;

  @Column({ type: 'varchar', length: 32 })
  public sourceId: string;

  @Column({ type: 'varchar', length: 2048 })
  public url: string;

  @Column({ type: 'varchar', length: 64 })
  public urlHash: string;

  @Column({ type: 'integer' })
  public suwayomiMangaId: number;

  @Column({ type: 'varchar', length: 512 })
  public title: string;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<MangaMatchCandidate>) {
    Object.assign(this, init);
  }
}

export default MangaMatchCandidate;
