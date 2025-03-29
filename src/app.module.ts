import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersModule } from './orders/orders.module';
import { CommonModule } from './common/common.module';
import { StampsModule } from './stamps/stamps.module';
import { FontsModule } from './fonts/fonts.module';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { BasketModule } from './basket/basket.module';
import * as dotenv from 'dotenv';
dotenv.config({ override: true });

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        return {
          type: 'postgres',
          host: configService.get('DB_HOST'),
          port: +configService.get('DB_PORT'),
          username: configService.get('DB_USER'),
          password: configService.get('DB_PASSWORD'),
          database: configService.get('DB_NAME'),
          entities: [__dirname + '/**/*.entity{.ts,.js}'],
          synchronize: false, // 注意：生产环境不建议使用
        };
      },
      inject: [ConfigService],
    }),
    OrdersModule,
    CommonModule,
    StampsModule,
    FontsModule,
    UsersModule,
    AuthModule,
    BasketModule,
  ],
})
export class AppModule {} 