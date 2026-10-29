import { forwardRef, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import * as fs from 'fs';

import { StampsController } from './stamps.controller';
import { StampsService } from './stamps.service';
import { StampTemplate } from './entities/stamp-template.entity';
import { StampGenerationRecord } from './entities/stamp-generation-record.entity';
import { OrderStampService } from './services/order-stamp.service';
import { PythonStampService } from './services/python-stamp.service';
import { CommonModule } from '../common/common.module';
import { Font } from '../fonts/entities/font.entity';
import { OrdersModule } from 'src/orders/orders.module';
import { Order } from '../orders/entities/order.entity';
import { StampTemplateShare } from './entities/stamp-template-share.entity';
import { OrderDesignBackup } from '../orders/entities/order-design-backup.entity';
import { User } from '../users/entities/user.entity';
import { RattleIconAsset } from '../rattle-icon-library/entities/rattle-icon-asset.entity';
import { StampCategoriesModule } from '../stamp-categories/stamp-categories.module';
import { TemplateMatchService } from './services/template-match.service';

// Ensure uploads directory exists
const UPLOADS_DIR = 'uploads';
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

@Module({
  imports: [
    TypeOrmModule.forFeature([StampTemplate, StampGenerationRecord, StampTemplateShare, Font, Order, OrderDesignBackup, User, RattleIconAsset]),
    CommonModule,
    StampCategoriesModule,
    forwardRef(() => OrdersModule),
    MulterModule.register({
      storage: diskStorage({
        destination: (req, file, cb) => {
          cb(null, UPLOADS_DIR);
        },
        filename: (req, file, cb) => {
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
          const ext = path.extname(file.originalname);
          cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
        },
      }),
    }),
  ],
  controllers: [StampsController],
  providers: [StampsService, OrderStampService, PythonStampService, TemplateMatchService],
  exports: [StampsService, OrderStampService, PythonStampService, TemplateMatchService, TypeOrmModule.forFeature([StampGenerationRecord])],
})
export class StampsModule {} 