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
        orderWithDetails.orderDetails = {
          orderId: order.etsyOrder.orderId,
          itemName: order.etsyOrder.itemName,
          buyer: order.etsyOrder.buyer,
          price: order.etsyOrder.price,
          quantity: order.etsyOrder.quantity,
          shipName: order.etsyOrder.shipName,
          shipAddress: order.etsyOrder.shipAddress1,
          shipCity: order.etsyOrder.shipCity,
          shipState: order.etsyOrder.shipState,
          shipZipcode: order.etsyOrder.shipZipcode,
          shipCountry: order.etsyOrder.shipCountry,
          variations: order.etsyOrder.variations,
        };
      } else {
        orderWithDetails.orderDetails = null;
      }
      return orderWithDetails;
    });
  }

  async findAll(paginationDto: PaginationDto): Promise<PaginatedResponse<Order>> {
    const { page = 1, limit = 10 } = paginationDto;
    const skip = (page - 1) * limit;

    const [items, total] = await this.ordersRepository.findAndCount({
      relations: ['etsyOrder'],
      skip,
      take: limit,
      order: {
        createdAt: 'DESC'
      }
    });

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