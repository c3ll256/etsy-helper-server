import { ApiProperty } from '@nestjs/swagger';

export class BasketGenerationResponseDto {
  @ApiProperty({ description: '生成记录ID', example: 1 })
  id: number;

  @ApiProperty({ description: '任务队列ID', example: 'e9b3af7c-7458-4a87-9b6f-26e9ed5e5e1a' })
  jobId: string;

  @ApiProperty({ description: '处理状态', enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'], example: 'pending' })
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

  @ApiProperty({ description: '处理进度 (0-100)', example: 0 })
  progress: number;

  @ApiProperty({ description: '原始文件名', example: 'basket_orders.xlsx' })
  originalFilename: string;

  @ApiProperty({ description: '订单类型', enum: ['basket', 'backpack', 'all'], example: 'basket' })
  orderType: 'basket' | 'backpack' | 'all';

  @ApiProperty({ description: '创建时间', example: '2023-01-01T00:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ 
    description: '输出文件信息',
    type: 'object',
    properties: {
      zipPath: { 
        type: 'string',
        description: 'ZIP文件路径，包含PPT和带高亮的Excel文件'
      },
      totalOrders: {
        type: 'number',
        description: '处理的订单总数'
      }
    }
  })
  output?: {
    zipPath: string;
    totalOrders: number;
  };
} 