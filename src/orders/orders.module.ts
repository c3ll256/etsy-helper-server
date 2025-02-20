import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { Order } from './entities/order.entity';
import { EtsyOrder } from './entities/etsy-order.entity';
import { ExcelService } from './services/excel.service';
import { EtsyOrderService } from './services/etsy-order.service';

@Module({
  imports: [TypeOrmModule.forFeature([Order, EtsyOrder])],
  controllers: [OrdersController],
  providers: [OrdersService, ExcelService, EtsyOrderService],
})
export class OrdersModule {} 