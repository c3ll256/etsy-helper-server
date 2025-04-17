import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('fonts')
export class Font {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  name: string;

  @Column({ unique: true })
  filename: string;

  @Column()
  filePath: string;

  @Column({ default: 'regular' })
  fontWeight: string;

  @Column({ default: false })
  isVariableFont: boolean;

  @Column({ nullable: true })
  description: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  updatedAt: Date;
} 