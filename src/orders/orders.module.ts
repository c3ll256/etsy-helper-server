import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { Order } from './entities/order.entity';
import { EtsyOrder } from './entities/etsy-order.entity';
import { ExcelService } from './services/excel.service';
import { EtsyOrderService } from './services/etsy-order.service';
import { StampsModule } from '../stamps/stamps.module';
import { CommonModule } from '../common/common.module';
import { JobQueueService } from './services/job-queue.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, EtsyOrder]),
    StampsModule,
    CommonModule
  ],
  controllers: [OrdersController],
  providers: [OrdersService, ExcelService, EtsyOrderService, JobQueueService],
  exports: [OrdersService]
})
export class OrdersModule {} 