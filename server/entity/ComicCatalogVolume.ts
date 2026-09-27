import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('comic_catalog_volume')
@Index('IDX_comic_catalog_volume_generation_title', ['generation', 'title'])
@Index('IDX_comic_catalog_volume_generation_publisher', [
  'generation',
  'publisherKey',
])
@Index('IDX_comic_catalog_volume_generation_year', ['generation', 'startYear'])
@Index('IDX_comic_catalog_volume_generation_issues', [
  'generation',
  'issueCount',
])
export class ComicCatalogVolume {
  @PrimaryColumn({ type: 'integer' })
  public generation: number;

  @PrimaryColumn({ type: 'integer' })
  public id: number;

  @Column({ type: 'varchar', length: 1000 })
  public title: string;

  @Column({ type: 'text' })
  public searchText: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  public publisherKey?: string | null;

  @Column({ type: 'integer', nullable: true })
  public startYear?: number | null;

  @Column({ type: 'integer', nullable: true })
  public issueCount?: number | null;

  @Column({ type: 'text' })
  public payload: string;
}

export default ComicCatalogVolume;
