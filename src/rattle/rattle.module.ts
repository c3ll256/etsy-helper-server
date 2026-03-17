import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
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