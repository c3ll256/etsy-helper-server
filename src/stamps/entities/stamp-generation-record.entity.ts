import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, ManyToOne, JoinColumn } from 'typeorm';
import { StampTemplate } from './stamp-template.entity';
import { ApiProperty } from '@nestjs/swagger';

export interface StampGenerationTextElement {
  id: string;
  value: string;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: string;
  fontStyle?: string;
  color?: string;
  position?: {
    x: number;
    y: number;
    width?: number;
    height?: number;
    rotation?: number;
    textAlign?: 'left' | 'center' | 'right';
  };
}

@Entity('stamp_generation_records')
export class StampGenerationRecord {
  @ApiProperty({ description: '记录ID' })
  @PrimaryGeneratedColumn()
  id: number;

  @ApiProperty({ description: '关联的订单ID' })
  @Column()
  orderId: string;

  @ApiProperty({ description: '关联的模板ID' })
  @Column()
  templateId: number;

  @ApiProperty({ description: '模板关联' })
  @ManyToOne(() => StampTemplate)
  @JoinColumn({ name: 'templateId' })
  template: StampTemplate;

  @ApiProperty({ 
    description: '文本元素及其样式设置',
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '文本元素ID' },
        value: { type: 'string', description: '文本内容' },
        fontFamily: { type: 'string', description: '字体' },
        fontSize: { type: 'number', description: '字体大小' },
        fontWeight: { type: 'string', description: '字体粗细' },
        fontStyle: { type: 'string', description: '字体样式' },
        color: { type: 'string', description: '颜色' },
        position: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X坐标' },
            y: { type: 'number', description: 'Y坐标' },
            width: { type: 'number', description: '宽度' },
            height: { type: 'number', description: '高度' },
            rotation: { type: 'number', description: '旋转角度' },
            textAlign: { type: 'string', enum: ['left', 'center', 'right'], description: '文本对齐方式' }
          }
        }
      }
    }
  })
  @Column('json')
  textElements: StampGenerationTextElement[];

  @ApiProperty({ description: '生成的图章图片URL' })
  @Column()
  stampImageUrl: string;

  @ApiProperty({ description: '输出格式' })
  @Column({ default: 'png' })
  format: string;

  @ApiProperty({ description: '创建时间' })
  @CreateDateColumn()
  createdAt: Date;

  @ApiProperty({ description: '更新时间' })
  @UpdateDateColumn()
  updatedAt: Date;
} 