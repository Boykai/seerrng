import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from './User';

export type GameLibraryCategory = 'game' | 'retro' | 'modern';
export type GameLibraryStatus =
  'backlog' | 'playing' | 'played' | 'completed' | 'paused' | 'dropped';

@Entity('game_library_entry')
@Index('IDX_game_library_entry_user_key', ['userId', 'externalKey'], {
  unique: true,
})
@Index('IDX_game_library_entry_user_catalog', ['userId', 'catalogId'])
@Index('IDX_game_library_entry_household', [
  'shareWithHousehold',
  'catalogId',
  'steamAppId',
])
export default class GameLibraryEntry {
  public constructor(init?: Partial<GameLibraryEntry>) {
    Object.assign(this, init);
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'int' })
  public userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  public user: User;

  /** `igdb:<id>` for catalog items or `steam:<appid>` for unmatched imports. */
  @Column({ type: 'varchar', length: 80 })
  public externalKey: string;

  @Column({ type: 'int', nullable: true })
  public catalogId: number | null;

  @Column({ type: 'varchar', length: 8 })
  public category: GameLibraryCategory;

  @Column({ type: 'varchar', length: 512 })
  public title: string;

  @Column({ type: 'text', default: '' })
  public summary: string;

  @Column({ type: 'varchar', length: 2048, default: '' })
  public coverUrl: string;

  @Column({ type: 'varchar', length: 32, default: '' })
  public releaseDate: string;

  /** Personal progress is independent from shared-server acquisition state. */
  @Column({ type: 'varchar', length: 16, default: 'backlog' })
  public status: GameLibraryStatus;

  /** Ownership the user entered manually, across any store or physical copy. */
  @Column({ type: 'boolean', default: false })
  public isOwned: boolean;

  /** Steam ownership and playtime are kept as source facts, not manual claims. */
  @Column({ type: 'int', nullable: true })
  public steamAppId: number | null;

  @Column({ type: 'boolean', default: false })
  public steamOwned: boolean;

  @Column({ type: 'int', default: 0 })
  public playtimeMinutes: number;

  @Column({ type: 'varchar', length: 120, default: '' })
  public storeName: string;

  @Column({ type: 'varchar', length: 120, default: '' })
  public platformName: string;

  /** Entries remain private until their owner explicitly shares them. */
  @Column({ type: 'boolean', default: false })
  public shareWithHousehold: boolean;

  @Column({ type: 'varchar', length: 8, default: 'manual' })
  public source: 'manual' | 'steam';

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastSyncedAt: Date | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({ type: 'datetime' })
  public updatedAt: Date;
}
