import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

export enum VideoMetadataSource {
  TMDB = 'tmdb',
  TVDB = 'tvdb',
  TVMAZE = 'tvmaze',
  WIKIDATA = 'wikidata',
}

export type VideoMetadataMediaType = 'movie' | 'tv';

/**
 * A source-native metadata snapshot. Provider records stay separate so a
 * merged movie or series can retain field-level provenance and expire each
 * provider's data according to its own refresh policy.
 */
@Entity({ name: 'video_metadata_source_record' })
@Unique('UQ_video_metadata_source_identity', [
  'mediaType',
  'provider',
  'sourceId',
])
@Index('IDX_video_metadata_source_tmdb', ['mediaType', 'tmdbId'])
@Index('IDX_video_metadata_source_tvdb', ['mediaType', 'tvdbId'])
@Index('IDX_video_metadata_source_imdb', ['mediaType', 'imdbId'])
@Index('IDX_video_metadata_source_tvmaze', ['mediaType', 'tvmazeId'])
@Index('IDX_video_metadata_source_wikidata', ['mediaType', 'wikidataId'])
@Index('IDX_video_metadata_source_expiry', ['expiresAt'])
export class VideoMetadataSourceRecord {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'varchar', length: 16 })
  public mediaType: VideoMetadataMediaType;

  @Column({ type: 'varchar', length: 16 })
  public provider: VideoMetadataSource;

  @Column({ type: 'varchar', length: 256 })
  public sourceId: string;

  @Column({ type: 'int', nullable: true })
  public tmdbId?: number | null;

  @Column({ type: 'int', nullable: true })
  public tvdbId?: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  public imdbId?: string | null;

  @Column({ type: 'int', nullable: true })
  public tvmazeId?: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  public wikidataId?: string | null;

  @Column({ type: 'text' })
  public payload: string;

  @Column({ type: 'text', nullable: true })
  public attributionUrl?: string | null;

  @DbAwareColumn({ type: 'datetime' })
  public fetchedAt: Date;

  @DbAwareColumn({ type: 'datetime' })
  public refreshAt: Date;

  @DbAwareColumn({ type: 'datetime' })
  public expiresAt: Date;
}
