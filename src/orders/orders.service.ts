import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { Order } from './entities/order.entity';
import { EtsyOrder } from './entities/etsy-order.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStampDto } from './dto/update-order-stamp.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';
import { StampsService } from '../stamps/stamps.service';
import { OrderStampService } from '../stamps/services/order-stamp.service';

@Injectable()
export class OrdersService {
  private readonly stampsOutputDir = 'uploads/stamps';

  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    @InjectRepository(EtsyOrder)
    private etsyOrderRepository: Repository<EtsyOrder>,
    private readonly stampsService: StampsService,
    private readonly orderStampService: OrderStampService,
  ) {
    // 确保印章输出目录存在
    if (!fs.existsSync(this.stampsOutputDir)) {
      fs.mkdirSync(this.stampsOutputDir, { recursive: true });
    }
  }

  async create(createOrderDto: CreateOrderDto): Promise<Order> {
    const order = this.ordersRepository.create({
      status: createOrderDto.status,
      orderType: createOrderDto.orderType
    });
    return await this.ordersRepository.save(order);
  }

  private async addOrderDetails(orders: Order[]): Promise<Order[]> {
    return orders.map(order => {
      const orderWithDetails = { ...order };
      if (order.orderType === 'etsy' && order.etsyOrder) {
        orderWithDetails.orderDetails = order.etsyOrder;
      } else {
        orderWithDetails.orderDetails = null;
      }
      return orderWithDetails;
    });
  }

  async findAll(paginationDto: PaginationDto): Promise<PaginatedResponse<Order>> {
    const { page = 1, limit = 10, search, status, startDate, endDate } = paginationDto;
    const skip = (page - 1) * limit;

    const queryBuilder = this.ordersRepository.createQueryBuilder('order')
      .leftJoinAndSelect('order.etsyOrder', 'etsyOrder')
      .orderBy('order.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    // Apply status filter if provided
    if (status) {
      queryBuilder.andWhere('order.status = :status', { status });
    }

    // 这里筛选的是导入时间
    if (startDate) {
      queryBuilder.andWhere('order.createdAt >= :startDate', { startDate });
    }

    if (endDate) {
      queryBuilder.andWhere('order.createdAt <= :endDate', { endDate });
    }

    // Apply search filter if provided
    if (search) {
      queryBuilder.andWhere(
        '(etsyOrder.orderId LIKE :search OR CAST(order.id as TEXT) LIKE :search OR order.platformOrderId LIKE :search OR order.searchKey ILIKE :search)',
        { search: `%${search}%` }
      );
    }

    const [items, total] = await queryBuilder.getManyAndCount();
    const ordersWithDetails = await this.addOrderDetails(items);

    return {
      items: ordersWithDetails,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
      }
    };
  }

  async findOne(id: string): Promise<Order> {
    const order = await this.ordersRepository.findOne({
      where: { id },
      relations: ['etsyOrder']
    });

    if (!order) {
      throw new NotFoundException(`Order with ID "${id}" not found`);
    }

    const [orderWithDetails] = await this.addOrderDetails([order]);
    return orderWithDetails;
  }

  async update(id: string, updateOrderDto: Partial<CreateOrderDto>): Promise<Order> {
    const order = await this.findOne(id);
    Object.assign(order, updateOrderDto);
    return await this.ordersRepository.save(order);
  }

  async remove(id: string): Promise<void> {
    const result = await this.ordersRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`Order with ID "${id}" not found`);
    }
  }

  async updateOrderStamp(updateOrderStampDto: UpdateOrderStampDto): Promise<{ success: boolean; path?: string; error?: string; recordId?: number }> {
    try {
      // 查找订单
      const order = await this.ordersRepository.findOne({
        where: { id: updateOrderStampDto.orderId },
        relations: ['etsyOrder'],
      });

      if (!order) {
        throw new NotFoundException(`Order with ID ${updateOrderStampDto.orderId} not found`);
      }

      // 检查是否为Etsy订单
      if (order.orderType !== 'etsy' || !order.etsyOrder) {
        return {
          success: false,
          error: 'Only Etsy orders can have customized stamps'
        };
      }

      // 使用orderStampService生成印章并创建记录
      const result = await this.orderStampService.generateStampFromOrder(
        order.etsyOrder,
        updateOrderStampDto.textElements,
        updateOrderStampDto.templateId
      );

      if (!result.success) {
        return {
          success: false,
          error: result.error
        };
      }
      
      // 更新EtsyOrder的印章URL
      await this.etsyOrderRepository.update(
        { orderId: order.etsyOrder.orderId },
        { stampImageUrl: result.path }
      );
      
      // 更新订单状态为已生成印章待审核
      await this.ordersRepository.update(
        { id: order.id },
        { status: 'stamp_generated_pending_review' }
      );

      return {
        success: true,
        path: result.path,
        recordId: result.recordId
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getOrderStampRecords(orderId: string) {
    // 首先确认订单存在
    const order = await this.ordersRepository.findOne({
      where: { id: orderId }
    });

    if (!order) {
      throw new NotFoundException(`Order with ID ${orderId} not found`);
    }

    // 从StampService获取记录
    return this.stampsService.getGenerationRecordsByOrderId(orderId);
  }

  async getOrderLatestStampRecord(orderId: string) {
    // 首先确认订单存在
    const order = await this.ordersRepository.findOne({
      where: { id: orderId }
    });

    if (!order) {
      throw new NotFoundException(`Order with ID ${orderId} not found`);
    }

    // 获取订单的最新印章生成记录
    const record = await this.stampsService.getLatestGenerationRecordByOrderId(orderId);
    
    if (!record) {
      throw new NotFoundException(`No stamp generation records found for order ${orderId}`);
    }
    
    return record;
  }
} 