import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import * as fs from 'fs';

import { FontsController } from './fonts.controller';
import { FontsService } from './fonts.service';
import { Font } from './entities/font.entity';
import { StampTemplate } from '../stamps/entities/stamp-template.entity';

// Ensure uploads directory exists
const UPLOADS_DIR = 'uploads/fonts';
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

@Module({
  imports: [
    TypeOrmModule.forFeature([Font, StampTemplate]),
    MulterModule.register({
      storage: diskStorage({
        destination: (req, file, cb) => {
          cb(null, UPLOADS_DIR);
        },
        filename: (req, file, cb) => {
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
          const ext = path.extname(file.originalname);
          cb(null, `font-${uniqueSuffix}${ext}`);
        },
      }),
    }),
  ],
  controllers: [FontsController],
  providers: [FontsService],
  exports: [FontsService, TypeOrmModule.forFeature([Font])],
})
export class FontsModule {} 