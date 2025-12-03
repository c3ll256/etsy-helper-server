import { Module, forwardRef } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';
import { Order } from './entities/order.entity';
import { EtsyOrder } from './entities/etsy-order.entity';
import { ExcelService } from './services/excel.service';
import { ExcelProcessingService } from './services/excel-processing.service';
import { ExcelExportService } from './services/excel-export.service';
import { OrderProcessingService } from './services/order-processing.service';
import { VariationParsingService } from './services/variation-parsing.service';
import { StampsModule } from '../stamps/stamps.module';
import { CommonModule } from '../common/common.module';
import { UsersModule } from '../users/users.module';
import { RemoteAreaService } from '../common/services/remote-area.service';
import { StampGenerationRecord } from '../stamps/entities/stamp-generation-record.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, EtsyOrder, StampGenerationRecord]),
    forwardRef(() => StampsModule),
    CommonModule,
    UsersModule
  ],
  controllers: [OrdersController],
  providers: [
    OrdersService, 
    ExcelService, 
    ExcelProcessingService,
    ExcelExportService,
    OrderProcessingService,
    VariationParsingService,
    RemoteAreaService
  ],
  exports: [OrdersService]
})
export class OrdersModule {} 