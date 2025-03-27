import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MinLength, IsOptional, IsBoolean } from 'class-validator';

export class UpdateUserDto {
  @ApiProperty({
    description: 'Username for login',
    example: 'shopowner1',
    required: false
  })
  @IsString()
  @IsOptional()
  username?: string;

  @ApiProperty({
    description: 'User password',
    example: 'newpassword123',
    required: false
  })
  @IsString()
  @IsOptional()
  @MinLength(6)
  password?: string;

  @ApiProperty({
    description: 'Determines if the user has admin privileges',
    example: false,
    required: false
  })
  @IsBoolean()
  @IsOptional()
  isAdmin?: boolean;

  @ApiProperty({
    description: 'The shop name associated with the user',
    example: 'MyShop',
    required: false
  })
  @IsString()
  @IsOptional()
  shopName?: string;
} 