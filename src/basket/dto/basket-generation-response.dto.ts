import { ApiProperty } from '@nestjs/swagger';

export class BasketGenerationResponseDto {
  @ApiProperty({ description: '生成记录ID', example: 1 })
  id: number;

  @ApiProperty({ description: '任务队列ID', example: 'e9b3af7c-7458-4a87-9b6f-26e9ed5e5e1a' })
  jobId: string;

  @ApiProperty({ description: '处理状态', enum: ['pending', 'processing', 'completed', 'failed'], example: 'pending' })
  status: 'pending' | 'processing' | 'completed' | 'failed';

  @ApiProperty({ description: '处理进度 (0-100)', example: 0 })
  progress: number;

  @ApiProperty({ description: '原始文件名', example: 'basket_orders.xlsx' })
  originalFilename: string;

  @ApiProperty({ description: '订单类型', enum: ['basket', 'backpack'], example: 'basket' })
  orderType: 'basket' | 'backpack';

  @ApiProperty({ description: '创建时间', example: '2023-01-01T00:00:00.000Z' })
  createdAt: Date;
} 