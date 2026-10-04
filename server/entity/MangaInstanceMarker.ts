import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * The marker SeerrNG writes to a Suwayomi instance's global meta before its
 * first write there. A random UUID per configured instance, never derived from
 * the address or login; a server carrying another value is left alone.
 */
@Entity('manga_instance_marker')
@Unique('UQ_manga_instance_marker_instance', ['instanceId'])
@Unique('UQ_manga_instance_marker_marker', ['marker'])
export class MangaInstanceMarker {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'integer' })
  public instanceId: number;

  @Column({ type: 'varchar', length: 36 })
  public marker: string;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  constructor(init?: Partial<MangaInstanceMarker>) {
    Object.assign(this, init);
  }
}

export default MangaInstanceMarker;
