import { IsEnum } from 'class-validator';

export class CreateOrderDto {
  @IsEnum(['pending', 'processing', 'completed', 'cancelled'])
  status: string;

  @IsEnum(['etsy', 'manual', 'other'])
  orderType: string;
} 