import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StampCategory } from './stamp-category.entity';
import { StampTemplate } from '../stamps/entities/stamp-template.entity';
import { Order } from '../orders/entities/order.entity';
import { StampCategoriesService } from './stamp-categories.service';
import { StampCategoriesController } from './stamp-categories.controller';

@Module({
  imports: [TypeOrmModule.forFeature([StampCategory, StampTemplate, Order])],
  controllers: [StampCategoriesController],
  providers: [StampCategoriesService],
  exports: [StampCategoriesService],
})
export class StampCategoriesModule {}
