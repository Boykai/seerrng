import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('comic_catalog_scan')
export class ComicCatalogScan {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  public id: string;

  @Column({ type: 'integer', default: 1 })
  public scanGeneration: number;

  @Column({ type: 'integer', default: 0 })
  public completeGeneration: number;

  @Column({ type: 'integer', default: 1 })
  public nextPage: number;

  @Column({ type: 'integer', default: 0 })
  public totalResults: number;

  @Column({ type: 'integer', default: 0 })
  public indexedResults: number;

  @Column({ type: 'integer', default: 0 })
  public invalidResults: number;

  @Column({ type: 'integer', default: 0 })
  public lastVolumeId: number;

  @Column({ type: 'integer', default: 0 })
  public lastAttemptAt: number;

  @Column({ type: 'integer', default: 0 })
  public lastCompletedAt: number;

  @Column({ type: 'varchar', length: 32, nullable: true })
  public lastError?: string | null;
}

export default ComicCatalogScan;
