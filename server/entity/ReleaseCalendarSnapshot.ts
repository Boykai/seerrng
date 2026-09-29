import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity('release_calendar_snapshot')
@Index('IDX_release_calendar_snapshot_observed_at', ['observedAt'])
export default class ReleaseCalendarSnapshot {
  @PrimaryColumn({ type: 'varchar', length: 512 })
  public eventId: string;

  @Column({ type: 'varchar', length: 32 })
  public startsAt: string;

  @Column({ type: 'boolean' })
  public allDay: boolean;

  @Column({ type: 'varchar', length: 32 })
  public observedAt: string;

  @Column({ type: 'text', default: '[]' })
  public history: string;
}
