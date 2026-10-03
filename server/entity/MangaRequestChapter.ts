import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { MangaRequestManifest } from './MangaRequestManifest';

/**
 * One chapter of a frozen manifest, keyed by its source-relative URL. Suwayomi
 * chapter IDs are never stored: a backup restore can renumber them.
 */
@Entity('manga_request_chapter')
@Unique('UQ_manga_request_chapter_manifest_url', ['manifestId', 'urlHash'])
export class MangaRequestChapter {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'integer' })
  public manifestId: number;

  @ManyToOne(() => MangaRequestManifest, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'manifestId',
    foreignKeyConstraintName: 'FK_manga_request_chapter_manifest',
  })
  public manifest: MangaRequestManifest;

  @Column({ type: 'varchar', length: 2048 })
  public url: string;

  /** SHA-256 of `url`, which keeps the unique key within index size limits. */
  @Column({ type: 'varchar', length: 64 })
  public urlHash: string;

  @Column({ type: 'double precision', nullable: true })
  public chapterNumber: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  public scanlator: string | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  constructor(init?: Partial<MangaRequestChapter>) {
    Object.assign(this, init);
  }
}

export default MangaRequestChapter;
