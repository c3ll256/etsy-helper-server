import { Module } from '@nestjs/common';
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

// Ensure uploads directory exists
const UPLOADS_DIR = 'uploads';
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

@Module({
  imports: [
    TypeOrmModule.forFeature([StampTemplate, StampGenerationRecord, Font]),
    CommonModule,
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
  providers: [StampsService, OrderStampService, PythonStampService],
  exports: [StampsService, OrderStampService, PythonStampService, TypeOrmModule.forFeature([StampGenerationRecord])],
})
export class StampsModule {} 