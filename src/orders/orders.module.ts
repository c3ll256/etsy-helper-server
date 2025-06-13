import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { Order } from './entities/order.entity';
import { EtsyOrder } from './entities/etsy-order.entity';
import { ExcelService } from './services/excel.service';
import { StampsModule } from '../stamps/stamps.module';
import { CommonModule } from '../common/common.module';
import { UsersModule } from '../users/users.module';
import { RemoteAreaService } from '../common/services/remote-area.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, EtsyOrder]),
    forwardRef(() => StampsModule),
    CommonModule,
    UsersModule
  ],
  controllers: [OrdersController],
  providers: [OrdersService, ExcelService, RemoteAreaService],
  exports: [OrdersService]
})
export class OrdersModule {} 