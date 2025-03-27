import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class GenerateBasketOrderDto {
  @ApiProperty({
    description: 'The Excel file containing basket order data (base64 encoded)',
    type: 'string',
    format: 'binary',
  })
  @IsNotEmpty()
  file: Express.Multer.File;

  @ApiProperty({
    description: 'The original file name',
    required: false,
  })
  @IsOptional()
  @IsString()
  originalFilename?: string;
} 