import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { ApiProperty } from '@nestjs/swagger';
import { Order } from '../../orders/entities/order.entity';

@Entity('users')
export class User {
  @ApiProperty({
    description: 'The unique identifier for the user',
    example: '123e4567-e89b-12d3-a456-426614174000'
  })
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @ApiProperty({
    description: 'Username for login',
    example: 'shopowner1'
  })
  @Column({ unique: true })
  username: string;

  @ApiProperty({
    description: 'User password (hashed)',
    example: 'hashedpassword123'
  })
  @Column()
  password: string;

  @ApiProperty({
    description: 'Determines if the user has admin privileges',
    example: false
  })
  @Column({ default: false })
  isAdmin: boolean;

  @ApiProperty({
    description: 'The shop name associated with the user',
    example: 'MyShop',
    required: false
  })
  @Column({ nullable: true })
  shopName: string;

  @ApiProperty({
    description: 'Orders associated with this user',
    type: () => Order,
    isArray: true
  })
  @OneToMany(() => Order, order => order.user)
  orders: Order[];

  @ApiProperty({
    description: 'The creation timestamp',
    example: '2024-05-10T12:00:00Z'
  })
  @CreateDateColumn()
  createdAt: Date;

  @ApiProperty({
    description: 'The last update timestamp',
    example: '2024-05-10T12:00:00Z'
  })
  @UpdateDateColumn()
  updatedAt: Date;
} 