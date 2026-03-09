import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { SweaterController } from './sweater.controller';
import { SweaterService } from './sweater.service';
import { SweaterHeaderTemplate } from './entities/sweater-header-template.entity';
import { SweaterTransformJob } from './entities/sweater-transform-job.entity';
import { CommonModule } from '../common/common.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { ColorGroup } from '../basket/entities/color-group.entity';
import { ColorKv } from '../basket/entities/color-kv.entity';
import { SkuConfig } from '../basket/entities/sku-config.entity';

const SWEATER_UPLOADS_DIR = 'uploads/sweater/input';
if (!fs.existsSync(SWEATER_UPLOADS_DIR)) {
  fs.mkdirSync(SWEATER_UPLOADS_DIR, { recursive: true });
}

@Module({
  imports: [
    TypeOrmModule.forFeature([SweaterHeaderTemplate, SweaterTransformJob, ColorGroup, ColorKv, SkuConfig]),
    CommonModule,
    AuthModule,
    UsersModule,
    MulterModule.register({
      storage: diskStorage({
        destination: (req, file, cb) => cb(null, SWEATER_UPLOADS_DIR),
        filename: (req, file, cb) => {
          const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
          cb(null, `sweater-${uniqueSuffix}${path.extname(file.originalname)}`);
        },
      }),
    }),
  ],
  controllers: [SweaterController],
  providers: [SweaterService],
})
export class SweaterModule {}
