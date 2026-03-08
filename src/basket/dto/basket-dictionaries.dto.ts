import { ApiProperty, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class DictionaryPaginationDto {
  @ApiProperty({ required: false, default: 1 })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(1)
  limit?: number = 20;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  search?: string;
}

export class QueryColorGroupsDto extends DictionaryPaginationDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  productType?: string;
}

export class CreateColorGroupDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  productType?: string;
}

export class UpdateColorGroupDto extends PartialType(CreateColorGroupDto) {}

export class QueryColorKvDto extends DictionaryPaginationDto {
  @ApiProperty({ required: false })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  groupId?: number | null;
}

export class CreateColorKvDto {
  @ApiProperty({ required: false, nullable: true })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  groupId?: number | null;

  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsString()
  colorValue: string;
}

export class UpdateColorKvDto extends PartialType(CreateColorKvDto) {}

export class QueryIconGroupsDto extends DictionaryPaginationDto {}

export class CreateIconGroupDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  description?: string;
}

export class UpdateIconGroupDto extends PartialType(CreateIconGroupDto) {}

export class QueryIconKvDto extends DictionaryPaginationDto {
  @ApiProperty({ required: false })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  groupId?: number;
}

export class CreateIconKvDto {
  @ApiProperty({ required: false, nullable: true })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  groupId?: number | null;

  @ApiProperty()
  @IsString()
  name: string;
}

export class UpdateIconKvDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ required: false, nullable: true })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  groupId?: number | null;
}
