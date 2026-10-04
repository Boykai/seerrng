import Media from '@server/entity/Media';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity()
export class MediaSearchMetadata {
  @PrimaryColumn({ type: 'int' })
  public mediaId: number;

  @OneToOne(() => Media, (media) => media.searchMetadata, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'mediaId' })
  public media: Media;

  @Column({ type: 'text', nullable: true })
  public title?: string | null;

  @Column({ type: 'text', nullable: true })
  public overview?: string | null;

  @Column({ type: 'text', nullable: true })
  public posterPath?: string | null;

  @Column({ type: 'text', nullable: true })
  public alternateTitle?: string | null;

  @Column({ type: 'text', nullable: true })
  public releaseDate?: string | null;

  @Column({ type: 'text', nullable: true })
  public genres?: string | null;

  @Column({ type: 'text', nullable: true })
  public runtime?: string | null;

  @Column({ type: 'text', nullable: true })
  public creator?: string | null;

  @Column({ type: 'text', nullable: true })
  public director?: string | null;

  @Column({ type: 'text', nullable: true })
  public writer?: string | null;

  @Column({ type: 'text', nullable: true })
  public studio?: string | null;

  @Column({ type: 'text', nullable: true })
  public network?: string | null;

  @Column({ type: 'text', nullable: true })
  public artist?: string | null;

  @Column({ type: 'text', nullable: true })
  public albumType?: string | null;

  @Column({ type: 'text', nullable: true })
  public author?: string | null;

  @Column({ type: 'text', nullable: true })
  public publisher?: string | null;

  @Column({ type: 'text', nullable: true })
  public format?: string | null;

  @Column({ type: 'text', nullable: true })
  public provider?: string | null;

  @Column({ type: 'text', nullable: true })
  public externalIds?: string | null;

  @Column({ type: 'text', default: '' })
  @Index()
  public searchText: string;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public videoMetadataExpiresAt?: Date | null;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public refreshedAt: Date;
}
