import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** Last-known successful TMDB data for the built-in Popular and Upcoming shelves. */
@Entity({ name: 'discover_movie_feed_snapshot' })
@Index('IDX_discover_movie_feed_snapshot_fetched', ['fetchedAt'])
export class DiscoverMovieFeedSnapshot {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  public cacheKey: string;

  @Column({ type: 'text' })
  public payload: string;

  @DbAwareColumn({ type: 'datetime' })
  public fetchedAt: Date;
}
