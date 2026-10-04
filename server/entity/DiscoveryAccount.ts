import { User } from '@server/entity/User';
import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type DiscoveryAccountProvider = 'trakt' | 'anilist' | 'simkl';

@Entity('discovery_account')
@Index('IDX_discovery_account_user_provider', ['userId', 'provider'], {
  unique: true,
})
export default class DiscoveryAccount {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'int' })
  public userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  public user: User;

  @Column({ type: 'varchar' })
  public provider: DiscoveryAccountProvider;

  @Column({ type: 'varchar' })
  public clientId: string;

  @Column({ type: 'text', select: false })
  public accessToken: string;

  @Column({ type: 'text', nullable: true, select: false })
  public refreshToken: string | null;

  @Column({ type: 'int', nullable: true })
  public expiresAt: number | null;

  @Column({ type: 'varchar', default: '' })
  public providerUserId: string;

  @Column({ type: 'varchar', default: '' })
  public username: string;

  @Column({ type: 'boolean', default: false })
  public allowWrites: boolean;

  // AniList only: copy Planning manga into the SeerrNG watchlist.
  @Column({ type: 'boolean', default: false })
  public importMangaPlanning: boolean;

  // The last Planning entry the import has handled, in the list's order: its
  // change time (AniList updatedAt, in seconds) and its AniList media ID.
  @Column({ type: 'int', nullable: true })
  public mangaPlanningCursor: number | null;

  @Column({ type: 'int', nullable: true })
  public mangaPlanningCursorId: number | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public linkedAt: Date;
}
