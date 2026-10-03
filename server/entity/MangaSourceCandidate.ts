import type { MangaBindingConfidence } from '@server/entity/MangaSourceBinding';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * A source manga that the resolver found for a requested title, waiting for
 * an admin. A new search replaces the title's candidates.
 */
@Entity()
@Index(
  'UQ_manga_source_candidate_item',
  ['instanceId', 'anilistId', 'sourceId', 'urlHash'],
  { unique: true }
)
class MangaSourceCandidate {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'integer' })
  public instanceId: number;

  @Column({ type: 'integer' })
  public anilistId: number;

  @Column({ type: 'varchar', length: 32 })
  public sourceId: string;

  /** The source's name and language when it was searched, for the picker. */
  @Column({ type: 'varchar', length: 256, default: '' })
  public sourceName: string;

  @Column({ type: 'varchar', length: 32, default: '' })
  public sourceLang: string;

  /** Source-relative URL, never the resolved web address. */
  @Column({ type: 'varchar', length: 2048 })
  public url: string;

  @Column({ type: 'varchar', length: 64 })
  public urlHash: string;

  @Column({ type: 'integer' })
  public suwayomiMangaId: number;

  @Column({ type: 'varchar', length: 512 })
  public title: string;

  @Column({ type: 'boolean', default: false })
  public inLibrary: boolean;

  /** Per-mille title similarity; 1000 for an exact link. */
  @Column({ type: 'integer' })
  public score: number;

  /** EXACT_LINK, HIGH, MEDIUM or LOW. */
  @Column({ type: 'varchar', length: 16 })
  public confidence: MangaBindingConfidence;

  @Column({ type: 'varchar', length: 32 })
  public matchedBy: string;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  constructor(init?: Partial<MangaSourceCandidate>) {
    Object.assign(this, init);
  }
}

export default MangaSourceCandidate;
