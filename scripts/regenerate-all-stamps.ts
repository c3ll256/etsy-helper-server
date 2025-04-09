import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { OrdersService } from '../src/orders/orders.service';
import { StampsService } from '../src/stamps/stamps.service';
import { OrderStatus } from '../src/orders/enums/order.enum';
import { Order } from '../src/orders/entities/order.entity';
import { User } from '../src/users/entities/user.entity';

async function bootstrap() {
  try {
    // 创建 NestJS 应用实例
    const app = await NestFactory.createApplicationContext(AppModule);

    // 获取必要的服务
    const ordersService = app.get(OrdersService);
    const stampsService = app.get(StampsService);

    console.log('开始重新生成所有订单的印章...');

    // 创建一个新的作业ID
    const jobId = `regenerate-all-stamps-${Date.now()}`;

    // 创建一个管理员用户对象以访问所有订单
    const adminUser: Partial<User> = {
      id: '0',
      username: 'admin',
      isAdmin: true,
      shopName: 'admin'
    };

    // 获取所有已生成印章的订单
    const { items: allOrders } = await ordersService.findAll({
      page: 1,
      limit: 1000000,
    }, adminUser as User);

    // 合并两种状态的订单
    console.log(`找到 ${allOrders.length} 个订单需要重新生成印章`);

    // 按模板ID对订单进行分组
    const ordersByTemplate = new Map<number, Order[]>();
    for (const order of allOrders) {
      if (order.templateId) {
        if (!ordersByTemplate.has(order.templateId)) {
          ordersByTemplate.set(order.templateId, []);
        }
        ordersByTemplate.get(order.templateId)?.push(order);
      }
    }

    console.log(`订单按 ${ordersByTemplate.size} 个不同的模板分组`);

    // 对每个模板的订单组重新生成印章
    let processedTemplates = 0;
    for (const [templateId, templateOrders] of ordersByTemplate) {
      console.log(`\n处理模板 ${templateId} 的 ${templateOrders.length} 个订单...`);
      
      try {
        // 获取模板
        const template = await stampsService.findById(templateId, adminUser as User);
        if (!template) {
          console.error(`找不到模板 ${templateId}，跳过相关订单`);
          continue;
        }

        // 重新生成该模板的所有订单印章
        await stampsService.regenerateOrderStamps(
          templateId,
          template,
          `${jobId}-template-${templateId}`
        );

        processedTemplates++;
        console.log(`完成模板 ${templateId} 的处理 (${processedTemplates}/${ordersByTemplate.size})`);
      } catch (error) {
        console.error(`处理模板 ${templateId} 时出错:`, error);
      }
    }

    console.log('\n所有印章重新生成完成！');
    await app.close();
    process.exit(0);
  } catch (error) {
    console.error('发生错误:', error);
    process.exit(1);
  }
}

bootstrap(); 