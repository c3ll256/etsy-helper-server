import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum StampType {
  RUBBER = 'rubber',
  STEEL = 'steel',
  PHOTOSENSITIVE = 'photo',
  ACRYLIC = 'acryl',
  PHOTO_EGG = 'photo_egg',
  PHOTO_GOLF = 'photo_golf',
  PHOTO_CLOTHES = 'photo_clothes',
  GOLF_SET = 'golf_set',
  WAX_SEAL = 'wax_seal',
}

@Entity('stamp_templates')
export class StampTemplate {
  @PrimaryGeneratedColumn()
  id: number;

  @Column('text', { array: true, nullable: true })
  skus?: string[];

  @Column()
  name: string;

  @Column({ nullable: true })
  backgroundImagePath: string;

  @Column({ default: 500 })
  width: number;

  @Column({ default: 500 })
  height: number;

  @Column('json', { nullable: true })
  textElements: TextElement[];

  @Column({ nullable: true })
  description?: string;

  @Column({ type: 'varchar', length: 32, default: StampType.RUBBER })
  type: StampType;

  @Column({ type: 'uuid' })
  userId: string;

  @ManyToOne(() => User)
  user: User;

  @Column({ nullable: true })
  previewImagePath?: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @Column({ type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  updatedAt: Date;
}

export interface Position {
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
  textAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'baseline';
  isCircular?: boolean;
  radius?: number;
  baseAngle?: number;
  direction?: 'clockwise' | 'counterclockwise';
  baselinePosition?: 'inside' | 'outside';
  letterSpacing?: number;
  maxAngle?: number;
  layoutMode?: 'startAligned' | 'centerAligned';
}

export interface TextElement {
  id?: string;
  defaultValue?: string; 
  value?: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: string;
  color?: string;
  description?: string;
  isUppercase?: boolean;
  strokeWidth?: number;
  textPadding?: number;
  firstVariant?: number;
  lastVariant?: number;
  position: Position;
} 