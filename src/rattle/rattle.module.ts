import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MulterModule } from '@nestjs/platform-express';
import { RattleController } from './rattle.controller';
import { RattleService } from './rattle.service';
import { OrderUploadJob } from '../orders/entities/order-upload-job.entity';
import { OrderUploadJobItem } from '../orders/entities/order-upload-job-item.entity';
import { OrderUploadJobService } from '../orders/services/order-upload-job.service';
import { ExcelService } from '../orders/services/excel.service';
import { Order } from '../orders/entities/order.entity';
import { EtsyOrder } from '../orders/entities/etsy-order.entity';
import { OrdersModule } from '../orders/orders.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      OrderUploadJob,
      OrderUploadJobItem,
      Order,
      EtsyOrder,
    ]),
    MulterModule.register({
      storage: require('multer').memoryStorage(), // 使用内存存储而不是磁盘存储
      fileFilter: (req, file, cb) => {
        // 确保文件名正确编码
        if (file.originalname) {
          try {
            // 尝试修复可能的编码问题
            file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
          } catch (error) {
            // 如果转换失败，保持原始文件名
          }
        }
        cb(null, true);
      },
    }),
    OrdersModule, // 导入订单模块以获取ExcelService
  ],
  controllers: [RattleController],
  providers: [
    RattleService,
    OrderUploadJobService,
  ],
  exports: [RattleService],
})
export class RattleModule {}