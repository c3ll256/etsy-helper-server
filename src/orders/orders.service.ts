import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Order } from './entities/order.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
  ) {}

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

    // Apply date range filters if provided
    if (startDate) {
      queryBuilder.andWhere('order.platformOrderDate >= :startDate', { startDate });
    }

    if (endDate) {
      queryBuilder.andWhere('order.platformOrderDate <= :endDate', { endDate });
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
} 