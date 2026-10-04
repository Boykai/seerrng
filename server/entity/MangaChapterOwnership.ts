import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * A chapter download SeerrNG queued. Written before the enqueue and deleted
 * once the chapter is released, so only chapters SeerrNG queued are ever
 * dequeued. Requests don't cascade into it: how many requests still need the
 * chapter is derived from their frozen manifests.
 */
@Entity('manga_chapter_ownership')
@Unique('UQ_manga_chapter_ownership_item', [
  'instanceId',
  'sourceId',
  'mangaUrlHash',
  'chapterUrlHash',
])
export class MangaChapterOwnership {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'integer' })
  public instanceId: number;

  @Column({ type: 'varchar', length: 32 })
  public sourceId: string;

  /** SHA-256 of the manga's source-relative URL. */
  @Column({ type: 'varchar', length: 64 })
  public mangaUrlHash: string;

  /** SHA-256 of `chapterUrl`. */
  @Column({ type: 'varchar', length: 64 })
  public chapterUrlHash: string;

  /** Source-relative URL of the chapter. */
  @Column({ type: 'varchar', length: 2048 })
  public chapterUrl: string;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public enqueuedAt: Date;

  constructor(init?: Partial<MangaChapterOwnership>) {
    Object.assign(this, init);
  }
}

export default MangaChapterOwnership;
