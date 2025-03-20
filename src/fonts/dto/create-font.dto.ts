import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateFontDto {
  @ApiProperty({ description: 'Name of the font' })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({ description: 'Font weight (e.g., regular, bold, 700)', required: false })
  @IsOptional()
  @IsString()
  fontWeight?: string;

  @ApiProperty({ description: 'Font style (e.g., normal, italic)', required: false })
  @IsOptional()
  @IsString()
  fontStyle?: string;

  @ApiProperty({ description: 'Description of the font', required: false })
  @IsOptional()
  @IsString()
  description?: string;
} 