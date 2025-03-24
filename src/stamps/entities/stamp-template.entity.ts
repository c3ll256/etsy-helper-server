import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('stamp_templates')
export class StampTemplate {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  sku: string;

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

  @Column({ default: true })
  isActive: boolean;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  updatedAt: Date;
}

export interface TextElement {
  id: string;
  defaultValue: string;
  fontFamily: string;
  fontSize: number;
  fontWeight?: string;
  fontStyle?: string;
  color?: string;
  description?: string;
  position: {
    x: number;
    y: number;
    width?: number;
    height?: number;
    rotation?: number;
    textAlign?: 'left' | 'center' | 'right';
    verticalAlign?: 'top' | 'middle' | 'baseline';
    // Circular text properties
    isCircular?: boolean;
    radius?: number;
    startAngle?: number;
    endAngle?: number;
    direction?: 'clockwise' | 'counterclockwise';
  };
} 