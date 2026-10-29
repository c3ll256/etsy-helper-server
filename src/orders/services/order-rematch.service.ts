import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { Order, OrderMatchDetail } from '../entities/order.entity';
import { EtsyOrder } from '../entities/etsy-order.entity';
import { OrderDesignBackup } from '../entities/order-design-backup.entity';
import { OrderUploadJobItem } from '../entities/order-upload-job-item.entity';
import { OrderMatchStatus, OrderStatus, UNRESOLVED_MATCH_STATUSES } from '../enums/order.enum';
import { User } from '../../users/entities/user.entity';
import { StampTemplate } from '../../stamps/entities/stamp-template.entity';
import { TemplateMatchService } from '../../stamps/services/template-match.service';
import { OrderProcessingService } from './order-processing.service';

export type ReprocessMode = 'rematch' | 'regenerate';

export interface ReprocessItemResult {
  orderId: string;
  platformOrderId: string;
  sku: string;
  previousTemplateId: number | null;
  previousTemplateName?: string | null;
  matchStatus: OrderMatchStatus;
  templateId: number | null;
  templateName?: string | null;
  /** unchanged / regenerated / needs_confirmation / unresolved / failed / would_regenerate */
  action: string;
  message?: string;
}

/**
 * 已导入订单的重新匹配、重新处理和手动指定模板（S1.5、S1.6、S1.8、C3、C4）。
 * 覆盖已审核或人工调整过的设计前必须 confirmOverwrite；覆盖前写备份，旧图片文件保留。
 */
@Injectable()
export class OrderRematchService {
  private readonly logger = new Logger(OrderRematchService.name);

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(EtsyOrder)
    private readonly etsyOrderRepository: Repository<EtsyOrder>,
    @InjectRepository(OrderDesignBackup)
    private readonly backupRepository: Repository<OrderDesignBackup>,
    @InjectRepository(StampTemplate)
    private readonly templateRepository: Repository<StampTemplate>,
    @InjectRepository(OrderUploadJobItem)
    private readonly uploadJobItemRepository: Repository<OrderUploadJobItem>,
    private readonly templateMatchService: TemplateMatchService,
    private readonly orderProcessingService: OrderProcessingService,
  ) {}

  /** 已审核通过或人工调整过、且已有设计的订单，覆盖前需要确认 */
  needsOverwriteConfirmation(order: Order, etsyOrder?: EtsyOrder | null): boolean {
    const hasDesign = (etsyOrder?.stampImageUrls?.length || 0) > 0;
    if (!hasDesign) return false;
    return order.status === OrderStatus.STAMP_GENERATED_REVIEWED || !!order.designAdjustedAt;
  }

  async backupDesign(order: Order, etsyOrder: EtsyOrder | null, reason: string, user?: User): Promise<void> {
    if (!etsyOrder || (etsyOrder.stampImageUrls?.length || 0) === 0) return;
    await this.backupRepository.save(this.backupRepository.create({
      orderId: order.id,
      templateId: order.templateId ?? null,
      status: order.status,
      matchStatus: order.matchStatus ?? null,
      stampImageUrls: etsyOrder.stampImageUrls || [],
      stampGenerationRecordIds: etsyOrder.stampGenerationRecordIds || [],
      variations: etsyOrder.variations ?? null,
      reason,
      createdBy: (user?.id as string) ?? null,
    }));
  }

  async listBackups(orderId: string, user: User) {
    await this.loadOrder(orderId, user);
    return this.backupRepository.find({ where: { orderId }, order: { createdAt: 'DESC' } });
  }

  /** 从备份恢复：把订单的印章列表、模板和状态恢复到备份时（当前设计会先再备份一次） */
  async restoreBackup(orderId: string, backupId: number, user: User) {
    const { order, etsyOrder } = await this.loadOrder(orderId, user);
    const backup = await this.backupRepository.findOne({ where: { id: backupId, orderId } });
    if (!backup) throw new NotFoundException('备份不存在');
    await this.backupDesign(order, etsyOrder, 'before_restore', user);
    etsyOrder.stampImageUrls = backup.stampImageUrls || [];
    etsyOrder.stampGenerationRecordIds = backup.stampGenerationRecordIds || [];
    etsyOrder.variations = backup.variations;
    await this.etsyOrderRepository.save(etsyOrder);
    await this.orderRepository.update({ id: order.id }, {
      templateId: backup.templateId,
      status: (backup.status as OrderStatus) || order.status,
      matchStatus: (backup.matchStatus as OrderMatchStatus) || order.matchStatus,
    });
    return { success: true };
  }

  private async loadOrder(orderId: string, user?: User): Promise<{ order: Order; etsyOrder: EtsyOrder }> {
    const qb = this.orderRepository.createQueryBuilder('order')
      .leftJoinAndSelect('order.etsyOrder', 'etsyOrder')
      .leftJoinAndSelect('order.template', 'template')
      .leftJoinAndSelect('order.user', 'user')
      .where('order.id = :orderId', { orderId });
    if (user && !user.isAdmin) {
      qb.andWhere('order.userId = :userId', { userId: user.id });
    }
    const order = await qb.getOne();
    if (!order || !order.etsyOrder) {
      throw new NotFoundException(`订单 ${orderId} 不存在或无权访问`);
    }
    return { order, etsyOrder: order.etsyOrder };
  }

  /**
   * 单个 / 批量重新匹配（rematch）或按当前模板重新处理（regenerate）。
   * dryRun=true 只返回每单将发生什么，不改任何数据。
   */
  async reprocess(
    orderIds: string[],
    user: User,
    options: { mode: ReprocessMode; confirmOverwrite?: boolean; dryRun?: boolean },
  ): Promise<{ results: ReprocessItemResult[]; summary: Record<string, number> }> {
    if (!orderIds?.length) throw new BadRequestException('请选择订单');
    if (orderIds.length > 500) throw new BadRequestException('一次最多处理 500 个订单');

    const results: ReprocessItemResult[] = [];
    for (const orderId of orderIds) {
      try {
        results.push(await this.reprocessOne(orderId, user, options));
      } catch (error) {
        results.push({
          orderId,
          platformOrderId: '',
          sku: '',
          previousTemplateId: null,
          matchStatus: OrderMatchStatus.UNMATCHED,
          templateId: null,
          action: 'failed',
          message: error.message,
        });
      }
    }

    const summary: Record<string, number> = {};
    for (const item of results) {
      summary[item.action] = (summary[item.action] || 0) + 1;
    }
    return { results, summary };
  }

  private async reprocessOne(
    orderId: string,
    user: User,
    options: { mode: ReprocessMode; confirmOverwrite?: boolean; dryRun?: boolean },
  ): Promise<ReprocessItemResult> {
    const { order, etsyOrder } = await this.loadOrder(orderId, user);
    const sku = etsyOrder.sku || '';
    const base = {
      orderId: order.id,
      platformOrderId: order.platformOrderId,
      sku,
      previousTemplateId: order.templateId ?? null,
      previousTemplateName: order.template?.name ?? null,
    };

    let targetTemplate: StampTemplate | null = null;
    let matchStatus: OrderMatchStatus;
    let matchDetail: OrderMatchDetail;

    if (options.mode === 'regenerate') {
      // 按当前模板重新解析和生成；手动指定的保持 manual
      if (!order.templateId || UNRESOLVED_MATCH_STATUSES.includes(order.matchStatus as OrderMatchStatus)) {
        return {
          ...base,
          matchStatus: (order.matchStatus as OrderMatchStatus) || OrderMatchStatus.UNMATCHED,
          templateId: order.templateId ?? null,
          action: 'unresolved',
          message: '订单还没有确定的模板，请先重新匹配或手动指定模板',
        };
      }
      targetTemplate = await this.templateRepository.findOne({ where: { id: order.templateId }, withDeleted: true });
      if (!targetTemplate || targetTemplate.deletedAt) {
        return { ...base, matchStatus: order.matchStatus as OrderMatchStatus, templateId: order.templateId, action: 'failed', message: '当前模板已删除，请重新匹配或手动指定模板' };
      }
      matchStatus = (order.matchStatus as OrderMatchStatus) || OrderMatchStatus.EXACT;
      matchDetail = order.matchDetail || {
        rule: this.templateMatchService.describeRule(),
        orderSku: sku,
        matchedAt: new Date().toISOString(),
      };
    } else {
      // 订单属于谁，就按谁的模板范围匹配
      const owner = order.user || user;
      const match = await this.templateMatchService.match(sku, owner);
      matchStatus = match.status;
      matchDetail = { ...match.detail, previousTemplateId: order.templateId ?? null, matchedBy: user.username };
      targetTemplate = match.template || null;

      if (!targetTemplate) {
        if (!options.dryRun) {
          await this.orderRepository.update({ id: order.id }, {
            matchStatus,
            matchDetail,
            processingError: this.orderProcessingService.describeMatchProblem(matchStatus, matchDetail),
          });
        }
        return {
          ...base,
          matchStatus,
          templateId: order.templateId ?? null,
          action: 'unresolved',
          message: this.orderProcessingService.describeMatchProblem(matchStatus, matchDetail),
        };
      }

      const hasDesign = (etsyOrder.stampImageUrls?.length || 0) > 0;
      if (targetTemplate.id === order.templateId && hasDesign && order.status !== OrderStatus.STAMP_NOT_GENERATED) {
        if (!options.dryRun) {
          await this.orderRepository.update({ id: order.id }, { matchStatus, matchDetail, processingError: null });
        }
        return { ...base, matchStatus, templateId: targetTemplate.id, templateName: targetTemplate.name, action: 'unchanged', message: '模板未变化，设计保持不变' };
      }
    }

    return this.applyTemplate(order, etsyOrder, targetTemplate, matchStatus, matchDetail, user, {
      confirmOverwrite: options.confirmOverwrite,
      dryRun: options.dryRun,
      reason: options.mode,
      base,
    });
  }

  private async applyTemplate(
    order: Order,
    etsyOrder: EtsyOrder,
    template: StampTemplate,
    matchStatus: OrderMatchStatus,
    matchDetail: OrderMatchDetail,
    user: User,
    options: { confirmOverwrite?: boolean; dryRun?: boolean; reason: string; base: Omit<ReprocessItemResult, 'matchStatus' | 'templateId' | 'action'> },
  ): Promise<ReprocessItemResult> {
    const result = { ...options.base, matchStatus, templateId: template.id, templateName: template.name };

    if (this.needsOverwriteConfirmation(order, etsyOrder) && !options.confirmOverwrite) {
      const why = order.status === OrderStatus.STAMP_GENERATED_REVIEWED ? '已审核通过' : '设计已人工调整';
      return { ...result, action: 'needs_confirmation', message: `${why}，重新生成会覆盖当前设计（会先备份），需要确认` };
    }

    if (options.dryRun) {
      return { ...result, action: 'would_regenerate', message: `将按模板 ${template.name} 重新生成` };
    }

    await this.backupDesign(order, etsyOrder, options.reason, user);
    await this.orderRepository.update({ id: order.id }, { templateId: template.id, matchStatus, matchDetail });
    order.templateId = template.id;

    const generation = await this.orderProcessingService.parseAndGenerateForOrder(order, etsyOrder, template);
    if (!generation.success) {
      return { ...result, action: 'failed', message: generation.error };
    }
    return { ...result, action: 'regenerated', message: `已生成 ${generation.stamps.length} 张` };
  }

  /**
   * 手动指定模板（S1.6）
   * - scope=order：只改这一单
   * - scope=sku：同时把这单的完整 SKU 关联到所选模板，后续同 SKU 订单按新关联匹配；
   *   本账号其他模板上相同的 SKU 会被移除，避免后续变成冲突
   */
  async assignTemplate(
    orderId: string,
    templateId: number,
    scope: 'order' | 'sku',
    user: User,
    options: { confirmOverwrite?: boolean } = {},
  ): Promise<ReprocessItemResult & { skuLinkUpdate?: { addedTo: number; removedFrom: number[]; remainingConflicts: Array<{ templateId: number; templateName: string }> }; sameSkuOrderCount?: number }> {
    const { order, etsyOrder } = await this.loadOrder(orderId, user);
    const template = await this.templateRepository.findOne({ where: { id: templateId } });
    if (!template) throw new NotFoundException('模板不存在');
    if (!template.isActive) throw new BadRequestException('模板已停用');
    if (!(await this.templateMatchService.canUseTemplate(template, user))) {
      throw new ForbiddenException('没有使用该模板的权限');
    }

    const sku = (etsyOrder.sku || '').trim();
    const base = {
      orderId: order.id,
      platformOrderId: order.platformOrderId,
      sku,
      previousTemplateId: order.templateId ?? null,
      previousTemplateName: order.template?.name ?? null,
    };
    const matchDetail: OrderMatchDetail = {
      rule: 'manual',
      orderSku: sku,
      matchedSku: sku,
      reason: scope === 'sku' ? '手动指定并更新 SKU 关联' : '手动指定（仅本订单）',
      previousTemplateId: order.templateId ?? null,
      matchedAt: new Date().toISOString(),
      matchedBy: user.username,
    };

    // 先判断覆盖，避免 SKU 关联已改但设计没换
    if (this.needsOverwriteConfirmation(order, etsyOrder) && !options.confirmOverwrite) {
      const why = order.status === OrderStatus.STAMP_GENERATED_REVIEWED ? '已审核通过' : '设计已人工调整';
      return { ...base, matchStatus: OrderMatchStatus.MANUAL, templateId: template.id, templateName: template.name, action: 'needs_confirmation', message: `${why}，换模板会覆盖当前设计（会先备份），需要确认` };
    }

    let skuLinkUpdate;
    if (scope === 'sku') {
      if (!sku) throw new BadRequestException('订单没有 SKU，不能更新关联');
      if (template.userId !== user.id && !user.isAdmin) {
        throw new ForbiddenException('被授权的模板不能修改 SKU 关联，请联系模板所有者或使用"仅修改当前订单"');
      }
      skuLinkUpdate = await this.linkSkuToTemplate(sku, template, user);
    }

    const result = await this.applyTemplate(order, etsyOrder, template, OrderMatchStatus.MANUAL, matchDetail, user, {
      confirmOverwrite: true,
      reason: scope === 'sku' ? 'manual_sku' : 'manual_order',
      base,
    });

    const sameSkuOrderCount = sku
      ? await this.etsyOrderRepository.createQueryBuilder('e')
        .innerJoin('e.order', 'o')
        .where('TRIM(e.sku) = :sku', { sku })
        .andWhere('o.id != :id', { id: order.id })
        .andWhere('o.userId = :userId', { userId: order.userId })
        .getCount()
      : 0;

    return { ...result, skuLinkUpdate, sameSkuOrderCount };
  }

  private async linkSkuToTemplate(sku: string, template: StampTemplate, user: User) {
    const normalized = this.templateMatchService.normalizeSku(sku);
    const ownerTemplates = await this.templateRepository.find({ where: { userId: template.userId } });
    const removedFrom: number[] = [];
    for (const other of ownerTemplates) {
      if (other.id === template.id || !Array.isArray(other.skus)) continue;
      const kept = other.skus.filter(alias => this.templateMatchService.normalizeSku(alias) !== normalized);
      if (kept.length !== other.skus.length) {
        await this.templateRepository.update({ id: other.id }, { skus: kept });
        removedFrom.push(other.id);
      }
    }
    const alreadyLinked = (template.skus || []).some(alias => this.templateMatchService.normalizeSku(alias) === normalized);
    if (!alreadyLinked) {
      await this.templateRepository.update({ id: template.id }, { skus: [...(template.skus || []), sku] });
    }

    // 其他账号（授权或管理员可见范围内）仍然声明这个 SKU 的模板，后续仍会冲突，需要提示
    const scopeTemplates = await this.templateMatchService.getTemplatesInScope(user);
    const remainingConflicts = scopeTemplates
      .filter(t => t.id !== template.id && (t.skus || []).some(alias => this.templateMatchService.normalizeSku(alias) === normalized))
      .map(t => ({ templateId: t.id, templateName: t.name }));
    this.logger.log(`SKU ${sku} linked to template #${template.id}; removed from ${removedFrom.join(',') || 'none'}`);
    return { addedTo: template.id, removedFrom, remainingConflicts };
  }

  /**
   * 历史订单匹配审计：按当前规则重算，不改模板和设计，只写 matchStatus / matchDetail。
   * - 规则结果与当前模板一致 → exact
   * - 不一致 → mismatch（待复核，未复核前不能审核通过和导出）
   * - 规则下没有模板，但当前有模板 → legacy（历史模糊匹配，提示整理模板 SKU）
   * - 都没有 → unmatched
   * 默认只处理 matchStatus 为空的订单；overwrite=true 时重算除 manual 以外的全部。
   */
  async auditHistoricalMatches(user: User, options: { overwrite?: boolean; dryRun?: boolean } = {}) {
    if (!user.isAdmin) throw new ForbiddenException('只有管理员可以执行匹配审计');

    const where: any = options.overwrite
      ? { matchStatus: Not(OrderMatchStatus.MANUAL) }
      : { matchStatus: IsNull() };
    const orders = await this.orderRepository.find({
      where,
      relations: ['etsyOrder', 'user'],
    });

    // 按账号缓存可匹配模板
    const scopeCache = new Map<string, StampTemplate[]>();
    const counts: Record<string, number> = {};
    const mismatches: Array<{ orderId: string; platformOrderId: string; sku: string; currentTemplateId: number; suggestedTemplateId: number | null; status: string }> = [];

    for (const order of orders) {
      const sku = order.etsyOrder?.sku || '';
      const ownerKey = order.userId || 'none';
      if (!scopeCache.has(ownerKey)) {
        scopeCache.set(ownerKey, await this.templateMatchService.getTemplatesInScope(order.user || null));
      }
      const match = this.templateMatchService.matchAgainst(sku, scopeCache.get(ownerKey));
      let status: OrderMatchStatus;
      const suggested = match.template?.id ?? null;
      if (match.status === OrderMatchStatus.EXACT) {
        status = !order.templateId || suggested === order.templateId ? OrderMatchStatus.EXACT : OrderMatchStatus.MISMATCH;
      } else if (match.status === OrderMatchStatus.CONFLICT) {
        status = OrderMatchStatus.CONFLICT;
      } else {
        status = order.templateId ? OrderMatchStatus.LEGACY : OrderMatchStatus.UNMATCHED;
      }
      if (order.templateId && !suggested && status === OrderMatchStatus.EXACT) {
        status = OrderMatchStatus.LEGACY;
      }
      counts[status] = (counts[status] || 0) + 1;
      if (status === OrderMatchStatus.MISMATCH) {
        mismatches.push({ orderId: order.id, platformOrderId: order.platformOrderId, sku, currentTemplateId: order.templateId, suggestedTemplateId: suggested, status: order.status });
      }

      if (!options.dryRun) {
        await this.orderRepository.update({ id: order.id }, {
          matchStatus: status,
          matchDetail: {
            ...match.detail,
            reason: status === OrderMatchStatus.MISMATCH
              ? '历史订单当前模板与规则结果不一致，待复核'
              : status === OrderMatchStatus.LEGACY
                ? '历史订单靠旧的模糊匹配配上，按规则没有模板'
                : match.detail.reason,
            previousTemplateId: order.templateId ?? null,
            suggestedTemplateId: suggested,
            matchedBy: 'audit',
          },
        });
      }
    }

    return { total: orders.length, counts, mismatches };
  }

  /**
   * 历史备注补回：成功导入的行当时没有保存原始整行，只能从上传任务明细里留下原始行的记录补回
   * （主要是重复导入被跳过、或导入失败的行）。按交易号 + SKU 对应到订单，只补空备注，不覆盖已有内容。
   */
  async backfillBuyerNotes(user: User, options: { dryRun?: boolean } = {}) {
    if (!user.isAdmin) throw new ForbiddenException('只有管理员可以补回历史备注');
    const items = await this.uploadJobItemRepository
      .createQueryBuilder('item')
      .where(`item.detail_json ? 'originalData'`)
      .getMany();

    let matched = 0;
    let filled = 0;
    const filledOrders: string[] = [];
    for (const item of items) {
      const row = item.detailJson?.originalData;
      const note = this.orderProcessingService.extractBuyerNoteRaw(row);
      if (!note || !item.transactionId) continue;
      const candidates = await this.etsyOrderRepository.find({
        where: { transactionId: item.transactionId, sku: item.sku ? item.sku.trim() : undefined },
        relations: ['order'],
      });
      if (candidates.length === 0) continue;
      matched++;
      for (const etsyOrder of candidates) {
        if (etsyOrder.buyerNoteRaw) continue;
        filled++;
        filledOrders.push(etsyOrder.orderId);
        if (!options.dryRun) {
          await this.etsyOrderRepository.update({ id: etsyOrder.id }, { buyerNoteRaw: note, buyerNoteSource: 'backfill' });
        }
      }
    }
    return { scannedRows: items.length, matchedRows: matched, filledOrders: filled, sampleOrderIds: filledOrders.slice(0, 20) };
  }

  async updateBuyerNote(orderId: string, note: string, user: User) {
    const { etsyOrder } = await this.loadOrder(orderId, user);
    const text = (note ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    await this.etsyOrderRepository.update({ id: etsyOrder.id }, {
      buyerNoteRaw: text.length ? text : null,
      buyerNoteSource: text.length ? 'manual' : null,
    });
    return { success: true };
  }

  /** 查询某账号可选择的模板（手动指定模板的下拉框） */
  async listAssignableTemplates(user: User, search?: string, type?: string) {
    const templates = await this.templateMatchService.getTemplatesInScope(user);
    const keyword = (search || '').toLowerCase();
    return templates
      .filter(t => !type || (type === 'rattle' ? t.type === 'rattle' : t.type !== 'rattle'))
      .filter(t => !keyword || t.name.toLowerCase().includes(keyword) || (t.skus || []).some(s => s.toLowerCase().includes(keyword)))
      .slice(0, 50)
      .map(t => ({ id: t.id, name: t.name, skus: t.skus, type: t.type, userId: t.userId, previewImagePath: t.previewImagePath }));
  }

  async countByOrderIds(ids: string[]) {
    return this.orderRepository.count({ where: { id: In(ids) } });
  }
}
