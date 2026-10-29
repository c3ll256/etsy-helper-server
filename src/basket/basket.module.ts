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
import { ColorGroup } from './entities/color-group.entity';
import { ColorKv } from './entities/color-kv.entity';
import { IconGroup } from './entities/icon-group.entity';
import { IconKv } from './entities/icon-kv.entity';
import { PythonBasketService } from './services/python-basket.service';
import { BasketOrderLine } from './entities/basket-order-line.entity';
import { BasketIconLayoutTemplate } from './entities/basket-icon-layout-template.entity';
import { BasketReferenceImage } from './entities/basket-reference-image.entity';
import { BasketShopSettings } from './entities/basket-shop-settings.entity';
import { BasketLinesService } from './basket-lines.service';
import { BasketLinesController } from './basket-lines.controller';
import { Font } from '../fonts/entities/font.entity';
import { CommonModule } from '../common/common.module';
import { UsersModule } from '../users/users.module';
import { AuthModule } from '../auth/auth.module';
import { RemoteAreaService } from '../common/services/remote-area.service';

// Ensure uploads directory exists
const BASKETS_UPLOADS_DIR = 'uploads/baskets';
if (!fs.existsSync(BASKETS_UPLOADS_DIR)) {
  fs.mkdirSync(BASKETS_UPLOADS_DIR, { recursive: true });
}

@Module({
  imports: [
    TypeOrmModule.forFeature([BasketGenerationRecord, SkuConfig, ColorGroup, ColorKv, IconGroup, IconKv, BasketOrderLine, BasketIconLayoutTemplate, BasketReferenceImage, BasketShopSettings, Font]),
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
  controllers: [BasketLinesController, BasketController],
  providers: [BasketService, BasketLinesService, PythonBasketService, RemoteAreaService],
  exports: [BasketService, BasketLinesService, PythonBasketService],
})
export class BasketModule {} 
