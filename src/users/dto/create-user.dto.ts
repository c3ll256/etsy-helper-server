import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MinLength, IsOptional, IsBoolean } from 'class-validator';

export class CreateUserDto {
  @ApiProperty({
    description: 'Username for login',
    example: 'shopowner1'
  })
  @IsString()
  @IsNotEmpty()
  username: string;

  @ApiProperty({
    description: 'User password',
    example: 'password123'
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(6)
  password: string;

  @ApiProperty({
    description: 'Determines if the user has admin privileges',
    example: false,
    required: false
  })
  @IsBoolean()
  @IsOptional()
  isAdmin: boolean;

  @ApiProperty({
    description: 'The shop name associated with the user',
    example: 'MyShop',
    required: false
  })
  @IsString()
  @IsOptional()
  shopName: string;
} 