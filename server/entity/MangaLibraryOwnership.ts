import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Who put a source manga in an instance's library. Written before SeerrNG
 * adds the manga and never changed afterwards, so an entry the user already
 * had stays the user's. Requests don't cascade into it.
 */
@Entity('manga_library_ownership')
@Unique('UQ_manga_library_ownership_item', [
  'instanceId',
  'sourceId',
  'urlHash',
])
export class MangaLibraryOwnership {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'integer' })
  public instanceId: number;

  @Column({ type: 'varchar', length: 32 })
  public sourceId: string;

  /** SHA-256 of `url`. */
  @Column({ type: 'varchar', length: 64 })
  public urlHash: string;

  /** Source-relative URL of the manga. */
  @Column({ type: 'varchar', length: 2048 })
  public url: string;

  /** False when the manga was already in the library. */
  @Column({ type: 'boolean' })
  public addedBySeerrng: boolean;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  constructor(init?: Partial<MangaLibraryOwnership>) {
    Object.assign(this, init);
  }
}

export default MangaLibraryOwnership;
