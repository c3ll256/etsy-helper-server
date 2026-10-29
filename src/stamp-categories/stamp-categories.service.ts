import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { StampCategory } from './stamp-category.entity';
import { StampTemplate } from '../stamps/entities/stamp-template.entity';
import { Order } from '../orders/entities/order.entity';
import { OrderStatus } from '../orders/enums/order.enum';
import { User } from '../users/entities/user.entity';

@Injectable()
export class StampCategoriesService {
  constructor(
    @InjectRepository(StampCategory)
    private readonly categoryRepository: Repository<StampCategory>,
    @InjectRepository(StampTemplate)
    private readonly templateRepository: Repository<StampTemplate>,
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
  ) {}

  private assertAdmin(user: User) {
    if (!user.isAdmin) throw new ForbiddenException('只有管理员可以管理分类');
  }

  /** 分类列表，附带每个分类下的模板数和订单数 */
  async list(options: { includeDeleted?: boolean } = {}) {
    const categories = await this.categoryRepository.find({
      withDeleted: !!options.includeDeleted,
      order: { sortOrder: 'ASC', id: 'ASC' },
    });
    const templateCounts = await this.templateRepository.createQueryBuilder('t')
      .select('t.type', 'code').addSelect('COUNT(*)', 'count')
      .groupBy('t.type').getRawMany();
    const orderCounts = await this.orderRepository.createQueryBuilder('o')
      .innerJoin('o.template', 't').withDeleted()
      .select('t.type', 'code').addSelect('COUNT(*)', 'count')
      .groupBy('t.type').getRawMany();
    const tc = new Map(templateCounts.map(r => [r.code, Number(r.count)]));
    const oc = new Map(orderCounts.map(r => [r.code, Number(r.count)]));
    return categories.map(category => ({
      ...category,
      templateCount: tc.get(category.code) || 0,
      orderCount: oc.get(category.code) || 0,
    }));
  }

  async assertCodeExists(code: string | undefined | null) {
    if (!code) return;
    const exists = await this.categoryRepository.findOne({ where: { code } });
    if (!exists) throw new BadRequestException(`分类 ${code} 不存在或已删除`);
  }

  async create(body: { name: string; code?: string; sortOrder?: number }, user: User) {
    this.assertAdmin(user);
    const name = (body.name || '').trim();
    if (!name) throw new BadRequestException('请填写分类名称');
    const code = (body.code || `cat_${Date.now().toString(36)}`).trim();
    if (!/^[a-z0-9_]{2,32}$/.test(code)) throw new BadRequestException('分类代码只能用小写字母、数字和下划线（2-32 位）');
    const existing = await this.categoryRepository.findOne({ where: { code }, withDeleted: true });
    if (existing && !existing.deletedAt) throw new BadRequestException('分类代码已存在');
    if (existing?.deletedAt) {
      // 恢复同代码的已删除分类，历史模板会重新归到它下面
      await this.categoryRepository.restore(existing.id);
      await this.categoryRepository.update(existing.id, { name, sortOrder: body.sortOrder ?? existing.sortOrder });
      return this.categoryRepository.findOne({ where: { id: existing.id } });
    }
    const max = await this.categoryRepository.createQueryBuilder('c').withDeleted().select('MAX(c.sortOrder)', 'max').getRawOne();
    return this.categoryRepository.save(this.categoryRepository.create({
      code,
      name,
      sortOrder: body.sortOrder ?? (Number(max?.max) || 0) + 10,
    }));
  }

  async update(id: number, body: { name?: string; sortOrder?: number }, user: User) {
    this.assertAdmin(user);
    const category = await this.categoryRepository.findOne({ where: { id } });
    if (!category) throw new NotFoundException('分类不存在');
    const patch: Partial<StampCategory> = {};
    if (body.name !== undefined) {
      if (!body.name.trim()) throw new BadRequestException('请填写分类名称');
      patch.name = body.name.trim();
    }
    if (body.sortOrder !== undefined) patch.sortOrder = Number(body.sortOrder) || 0;
    await this.categoryRepository.update(id, patch);
    return this.categoryRepository.findOne({ where: { id } });
  }

  /** 删除前的影响：分类下的模板（含停用和已删除的）及关联订单 */
  async impact(id: number) {
    const category = await this.categoryRepository.findOne({ where: { id } });
    if (!category) throw new NotFoundException('分类不存在');
    const templates = await this.templateRepository.find({
      where: { type: category.code as any },
      withDeleted: true,
      order: { id: 'ASC' },
    });
    const activeTemplates = templates.filter(t => !t.deletedAt);
    const templateIds = templates.map(t => t.id);
    const orderCount = templateIds.length
      ? await this.orderRepository.count({ where: { templateId: In(templateIds) } })
      : 0;
    const reviewedOrderCount = templateIds.length
      ? await this.orderRepository.count({ where: { templateId: In(templateIds), status: OrderStatus.STAMP_GENERATED_REVIEWED } })
      : 0;
    return {
      category,
      canDelete: !category.isSystem && activeTemplates.length === 0,
      reason: category.isSystem
        ? '系统分类（摇铃）有独立的页面和流程，不能删除'
        : activeTemplates.length > 0
          ? `分类下还有 ${activeTemplates.length} 个模板，请先转移到其他分类`
          : null,
      templates: activeTemplates.map(t => ({ id: t.id, name: t.name, skus: t.skus, isActive: t.isActive, userId: t.userId })),
      deletedTemplateCount: templates.length - activeTemplates.length,
      orderCount,
      reviewedOrderCount,
      note: '删除分类不会删除模板，也不会改动任何订单；历史订单仍保留原模板和设计。',
    };
  }

  /** 把分类下的模板（全部或指定的）转移到另一个分类 */
  async transfer(id: number, body: { targetCode: string; templateIds?: number[] }, user: User) {
    this.assertAdmin(user);
    const category = await this.categoryRepository.findOne({ where: { id } });
    if (!category) throw new NotFoundException('分类不存在');
    if (category.isSystem) throw new BadRequestException('系统分类的模板不能转移');
    const target = await this.categoryRepository.findOne({ where: { code: body.targetCode } });
    if (!target) throw new BadRequestException('目标分类不存在');
    if (target.id === category.id) throw new BadRequestException('目标分类不能是当前分类');
    if (target.isSystem) throw new BadRequestException('不能把印章模板转移到摇铃分类');
    const qb = this.templateRepository.createQueryBuilder()
      .update(StampTemplate)
      .set({ type: target.code as any })
      .where('type = :code', { code: category.code });
    if (body.templateIds?.length) {
      qb.andWhere('id IN (:...ids)', { ids: body.templateIds });
    }
    const result = await qb.execute();
    return { moved: result.affected || 0, target: target.name };
  }

  async remove(id: number, user: User) {
    this.assertAdmin(user);
    const impact = await this.impact(id);
    if (!impact.canDelete) throw new BadRequestException(impact.reason);
    await this.categoryRepository.softDelete(id);
    return { success: true };
  }
}
