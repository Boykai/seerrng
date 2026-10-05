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

@Entity('game_library_account')
@Index('IDX_game_library_account_user', ['userId'], { unique: true })
@Index('IDX_game_library_account_steam_id', ['steamId'], { unique: true })
export default class GameLibraryAccount {
  public constructor(init?: Partial<GameLibraryAccount>) {
    Object.assign(this, init);
  }

  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'int' })
  public userId: number;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  public user: User;

  @Column({ type: 'varchar', length: 20 })
  public steamId: string;

  @Column({ type: 'varchar', length: 128, default: '' })
  public profileName: string;

  @Column({ type: 'int', default: 0 })
  public lastSyncCount: number;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public lastSyncedAt: Date | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public linkedAt: Date;

  @UpdateDateColumn({ type: 'datetime' })
  public updatedAt: Date;
}
