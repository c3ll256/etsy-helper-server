import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateFontDto {
  @ApiProperty({ description: 'Name of the font' })
  @IsNotEmpty()
  @IsString()
  name: string;

  @ApiProperty({ description: 'Font weight (e.g., regular, bold, 700)', required: false })
  @IsOptional()
  @IsString()
  fontWeight?: string = 'regular';

  @ApiProperty({ description: 'Whether this is a variable font', required: false })
  @IsOptional()
  @IsBoolean()
  isVariableFont?: boolean = false;

  @ApiProperty({ description: 'Description of the font', required: false })
  @IsOptional()
  @IsString()
  description?: string;
} 