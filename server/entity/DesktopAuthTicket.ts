import { DbAwareColumn } from '@server/utils/DbColumnHelper';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity()
@Index('IDX_desktop_auth_ticket_digest_unique', ['ticketDigest'], {
  unique: true,
})
export class DesktopAuthTicket {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column({ type: 'integer' })
  @Index('IDX_desktop_auth_ticket_user')
  public userId: number;

  @Column({ type: 'varchar', length: 255, select: false })
  public sessionId: string;

  @Column({ type: 'varchar', length: 20 })
  public credentialVersion: string;

  @Column({ type: 'varchar', length: 64 })
  public jellyfinUserId: string;

  @Column({ type: 'varchar', length: 16 })
  public jellyfinAuthorityKey: string;

  @Column({ type: 'varchar', length: 64 })
  public ticketDigest: string;

  @Column({ type: 'varchar', length: 64 })
  public challengeDigest: string;

  @Column({ type: 'integer' })
  public protocolVersion: number;

  @DbAwareColumn({ type: 'datetime' })
  @Index('IDX_desktop_auth_ticket_expires_at')
  public expiresAt: Date;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @DbAwareColumn({ type: 'datetime', nullable: true })
  public consumedAt?: Date | null;

  constructor(init?: Partial<DesktopAuthTicket>) {
    Object.assign(this, init);
  }
}
