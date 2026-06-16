import { ApiProperty } from '@nestjs/swagger';
import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../../users/entities/user.entity';

@Entity('color_groups')
export class ColorGroup {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  @ApiProperty({ description: '颜色组ID' })
  id: number;

  @Column({ type: 'uuid', name: 'user_id' })
  @ApiProperty({ description: '所属用户ID' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'varchar' })
  @ApiProperty({ description: '颜色组名称' })
  name: string;

  @Column({ type: 'text', nullable: true })
  @ApiProperty({ description: '颜色组描述', required: false })
  description?: string | null;

  @Column({ type: 'varchar', name: 'product_type' })
  @ApiProperty({ description: '产品类型', example: 'maternal_baby' })
  productType: string;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  @ApiProperty({ description: '是否启用' })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  @ApiProperty({ description: '创建时间' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  @ApiProperty({ description: '更新时间' })
  updatedAt: Date;
}
