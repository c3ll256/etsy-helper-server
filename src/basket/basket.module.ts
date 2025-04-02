import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import * as fs from 'fs';

import { BasketController } from './basket.controller';
import { BasketService } from './basket.service';
import { BasketGenerationRecord } from './entities/basket-generation-record.entity';
import { SkuConfig } from './entities/sku-config.entity';
import { PythonBasketService } from './services/python-basket.service';
import { CommonModule } from '../common/common.module';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';

// Ensure uploads directory exists
const BASKETS_UPLOADS_DIR = 'uploads/baskets';
if (!fs.existsSync(BASKETS_UPLOADS_DIR)) {
  fs.mkdirSync(BASKETS_UPLOADS_DIR, { recursive: true });
}

@Module({
  imports: [
    TypeOrmModule.forFeature([BasketGenerationRecord, SkuConfig]),
    CommonModule,
    UsersModule,
    AuthModule,
    MulterModule.register({
      storage: diskStorage({
        destination: (req, file, cb) => {
          cb(null, BASKETS_UPLOADS_DIR);
        },
        filename: (req, file, cb) => {
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
          const ext = path.extname(file.originalname);
          cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
        },
      }),
    }),
  ],
  controllers: [BasketController],
  providers: [BasketService, PythonBasketService],
  exports: [BasketService, PythonBasketService],
})
export class BasketModule {} 