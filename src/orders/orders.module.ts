import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { Order } from './entities/order.entity';
import { EtsyOrder } from './entities/etsy-order.entity';
import { ExcelService } from './services/excel.service';
import { EtsyOrderService } from './services/etsy-order.service';
import { StampGeneratorService } from './services/stamp-generator.service';

@Module({
  imports: [TypeOrmModule.forFeature([Order, EtsyOrder])],
  controllers: [OrdersController],
  providers: [OrdersService, ExcelService, EtsyOrderService, StampGeneratorService],
})
export class OrdersModule {} 