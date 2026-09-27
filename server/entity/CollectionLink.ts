import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** Independent of Media rows: deleting a movie must not lose collection intent. */
@Entity('collection_link')
export class CollectionLink {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  public id: string;

  @Index('IDX_collection_link_collection')
  @Column({ type: 'integer' })
  public collectionId: number;

  @Column({ type: 'varchar', length: 16, default: 'movie' })
  public sourceType: 'movie' | 'tv' | 'music' = 'movie';

  @Column({ type: 'varchar', length: 128, nullable: true })
  public sourceId: string | null = null;

  /** Already observed available titles: do not reinsert deliberately omitted or manually removed members. */
  @Column({ type: 'simple-json', nullable: true })
  public seenIds: string[] | null = null;

  @Column({ type: 'varchar', length: 128 })
  public serverId: string;

  @Column({ type: 'varchar', length: 128 })
  public libraryId: string;

  @Column({ type: 'varchar', length: 512 })
  public title: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  public remoteId: string | null = null;

  @Column({ type: 'boolean', default: false })
  public enabled = false;

  @Column({ type: 'varchar', length: 24, default: 'pending' })
  public state = 'pending';

  constructor(init?: Partial<CollectionLink>) {
    Object.assign(this, init);
  }
}
