import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Brackets, In, Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import * as AdmZip from 'adm-zip';
import * as dayjs from 'dayjs';
import { toBuffer as generateQrBuffer } from 'qrcode';

import { BasketGenerationRecord } from './entities/basket-generation-record.entity';
import { BasketOrderLine } from './entities/basket-order-line.entity';
import { BasketIconLayoutTemplate } from './entities/basket-icon-layout-template.entity';
import { BasketReferenceImage } from './entities/basket-reference-image.entity';
import { BasketShopSettings } from './entities/basket-shop-settings.entity';
import { SkuConfig } from './entities/sku-config.entity';
import { ColorKv } from './entities/color-kv.entity';
import { IconKv } from './entities/icon-kv.entity';
import { Font } from '../fonts/entities/font.entity';
import { User } from '../users/entities/user.entity';
import { AliyunService } from '../common/services/aliyun.service';
import { buildLineDrafts, PIPELINE_VERSION, PipelineContext, readExcelRows } from './pipeline/line-pipeline';
import { analyzeAll, runPipeline } from './pipeline/run-pipeline';
import { runPythonGenerator } from './pipeline/python-runner';
import { validateTemplate } from './pipeline/layout';
import { DEFAULT_SHOP_SETTINGS, LayoutTemplateLike, LineDraft, ManualOverride, ShopSettings, SkuConfigLike } from './pipeline/types';

export const EXCEPTION_CATEGORY_LABELS: Record<string, string> = {
  unmatched_sku: 'SKU 未配置',
  sku_conflict: 'SKU 匹配冲突',
  parse_review: '定制内容待核对',
  icon_asset_missing: '图标素材缺失（系统）',
  icon_insert_failed: '图标插入失败（系统）',
  icon_layout: '图标位置待核对',
  icon_limit: '图标超过上限',
  icon_config: 'SKU 未关联图标组（配置）',
  name_layout: '名字排版待核对',
  font_error: '字体异常（系统）',
  generation_failed: '生成失败（系统）',
  ready_to_regenerate: '已修正，待补处理生成',
};

export const LINE_STATUS_LABELS: Record<string, string> = {
  produced: '已生成',
  review: '待核对',
  failed: '系统异常',
  unmatched: 'SKU 未配置',
  conflict: 'SKU 冲突',
  duplicate: '导出重复',
  external: '正常连单（不做 PPT）',
  ignored: '非商品行',
  out_of_scope: '不在本次类型范围',
  pending: '处理中',
  ready: '已修正，待生成',
  backfilled: '历史补建（未重新生成）',
};

export interface LineQuery {
  page?: number;
  limit?: number;
  recordId?: number;
  orderId?: string;
  sku?: string;
  status?: string;
  category?: string;
  search?: string;
  onlyExceptions?: boolean;
  includeResolved?: boolean;
  orderNoPages?: boolean;
  startDate?: string;
  endDate?: string;
}

@Injectable()
export class BasketLinesService {
  private readonly logger = new Logger(BasketLinesService.name);
  private readonly uploadsDir = 'uploads/baskets';

  constructor(
    @InjectRepository(BasketGenerationRecord) private readonly recordRepo: Repository<BasketGenerationRecord>,
    @InjectRepository(BasketOrderLine) private readonly lineRepo: Repository<BasketOrderLine>,
    @InjectRepository(BasketIconLayoutTemplate) private readonly templateRepo: Repository<BasketIconLayoutTemplate>,
    @InjectRepository(BasketReferenceImage) private readonly refImageRepo: Repository<BasketReferenceImage>,
    @InjectRepository(BasketShopSettings) private readonly settingsRepo: Repository<BasketShopSettings>,
    @InjectRepository(SkuConfig) private readonly skuConfigRepo: Repository<SkuConfig>,
    @InjectRepository(ColorKv) private readonly colorKvRepo: Repository<ColorKv>,
    @InjectRepository(IconKv) private readonly iconKvRepo: Repository<IconKv>,
    @InjectRepository(Font) private readonly fontRepo: Repository<Font>,
    private readonly aliyunService: AliyunService,
    private readonly configService: ConfigService,
  ) {}

  // ================================================================ 上下文

  private isAdminGlobal(user: User): boolean {
    return !!user?.isAdmin && process.env.ENABLE_ADMIN_GLOBAL_SKU_MATCH === 'true';
  }

  private fileExists(p?: string | null): boolean {
    if (!p) return false;
    const rel = p.startsWith('/') ? p.slice(1) : p;
    return fs.existsSync(path.isAbsolute(p) && fs.existsSync(p) ? p : path.join(process.cwd(), rel));
  }

  toConfigLike(c: SkuConfig): SkuConfigLike {
    return {
      id: c.id,
      userId: c.userId,
      sku: c.sku,
      type: c.type,
      replaceValue: c.replaceValue,
      fontSize: c.fontSize,
      font: c.font,
      yarnColorMap: c.yarnColorMap,
      comboItems: c.comboItems,
      colorGroupId: c.colorGroupId ? Number(c.colorGroupId) : null,
      iconGroupId: c.iconGroupId ? Number(c.iconGroupId) : null,
      comboOverridesJson: c.comboOverridesJson as any,
      externalOrderReminderEnabled: c.externalOrderReminderEnabled,
      externalOrderReminderContent: c.externalOrderReminderContent,
      produceMode: (c.produceMode || 'ppt') as any,
      iconLayoutTemplateId: c.iconLayoutTemplateId ?? null,
      maxIcons: c.maxIcons ?? null,
      nameLayout: (c.nameLayout as any) ?? null,
    };
  }

  async getShopSettings(userId: string): Promise<ShopSettings> {
    const row = await this.settingsRepo.findOne({ where: { userId } });
    return { ...DEFAULT_SHOP_SETTINGS, ...(row?.settings || {}) };
  }

  async updateShopSettings(userId: string, patch: Partial<ShopSettings>): Promise<ShopSettings> {
    const allowed: Array<keyof ShopSettings> = Object.keys(DEFAULT_SHOP_SETTINGS) as any;
    const current = (await this.settingsRepo.findOne({ where: { userId } }))?.settings || {};
    const next: Record<string, any> = { ...current };
    for (const key of allowed) {
      if (patch[key] !== undefined) next[key] = patch[key];
    }
    if (next.specialCharAnnotationFontSize !== undefined && !(Number(next.specialCharAnnotationFontSize) > 0)) {
      throw new BadRequestException('标注字号必须大于 0');
    }
    await this.settingsRepo.save({ userId, settings: next });
    return { ...DEFAULT_SHOP_SETTINGS, ...next };
  }

  /** 装配一次生成需要的全部配置。普通账号只用自己的配置；管理员在开启全局匹配时使用所有账号的配置 */
  async buildContext(user: User, orderTypeScope: string, ownerUserId?: string): Promise<PipelineContext> {
    const ownerId = ownerUserId || user.id;
    const global = this.isAdminGlobal(user) && !ownerUserId;
    const configs = await this.skuConfigRepo.find({ where: global ? {} : { userId: ownerId } });
    const configLikes = configs.map((c) => this.toConfigLike(c));

    const iconGroupIds = new Set<number>();
    const colorGroupIds = new Set<number>();
    const templateIds = new Set<number>();
    for (const c of configLikes) {
      if (c.iconGroupId) iconGroupIds.add(Number(c.iconGroupId));
      if (c.colorGroupId) colorGroupIds.add(Number(c.colorGroupId));
      if (c.iconLayoutTemplateId) templateIds.add(Number(c.iconLayoutTemplateId));
      for (const o of Object.values(c.comboOverridesJson || {})) {
        if (o?.iconGroupId) iconGroupIds.add(Number(o.iconGroupId));
        if (o?.colorGroupId) colorGroupIds.add(Number(o.colorGroupId));
        if (o?.iconLayoutTemplateId) templateIds.add(Number(o.iconLayoutTemplateId));
      }
    }
    const iconGroups = new Map<number, any[]>();
    if (iconGroupIds.size) {
      const icons = await this.iconKvRepo.find({ where: { groupId: In([...iconGroupIds]) as any, isActive: true }, order: { id: 'ASC' } });
      for (const icon of icons) {
        const g = Number(icon.groupId);
        if (!iconGroups.has(g)) iconGroups.set(g, []);
        iconGroups.get(g)!.push({
          id: Number(icon.id), name: icon.name, code: icon.code, aliases: icon.aliases, kind: icon.kind || 'large',
          filePath: icon.filePath, fileExists: this.fileExists(icon.filePath),
        });
      }
    }
    const colorGroups = new Map<number, any[]>();
    if (colorGroupIds.size) {
      const colors = await this.colorKvRepo.find({ where: { groupId: In([...colorGroupIds]) as any, isActive: true } });
      for (const c of colors) {
        const g = Number(c.groupId);
        if (!colorGroups.has(g)) colorGroups.set(g, []);
        colorGroups.get(g)!.push({ name: c.name, colorValue: c.colorValue });
      }
    }
    const layoutTemplates = new Map<number, LayoutTemplateLike>();
    if (templateIds.size) {
      const templates = await this.templateRepo.find({ where: { id: In([...templateIds]), isActive: true } });
      for (const t of templates) layoutTemplates.set(t.id, { id: t.id, name: t.name, slots: t.slots, rules: t.rules, defaultOrder: t.defaultOrder });
    }
    const fonts = (await this.fontRepo.find({ where: { isActive: true } })).map((f) => ({ id: f.id, name: f.name, filePath: f.filePath, fileExists: this.fileExists(f.filePath) }));
    const settings = await this.getShopSettings(ownerId);
    const apiKey = this.configService.get<string>('aliyun.apiKey');
    return {
      configs: configLikes,
      iconGroups,
      colorGroups,
      layoutTemplates,
      fonts,
      settings,
      orderTypeScope,
      llm: apiKey
        ? (userPrompt: string, systemPrompt: string) => this.aliyunService.generateJson(userPrompt, { systemPrompt, temperature: 0 })
        : null,
    };
  }

  private python(request: any) {
    return runPythonGenerator(request, { pythonExecutable: process.env.PYTHON_EXECUTABLE?.trim() || 'python3' });
  }

  // ================================================================ 生成

  /**
   * 上传 Excel 后的完整流程（由 BasketService 的后台任务调用）：
   * 读取 → 去重 → 分析 → 布局计划 → 连单核对 → 渲染 → 打包 → 明细落库
   */
  async generateFromExcel(record: BasketGenerationRecord, excelPath: string, user: User, orderTypeScope: string, onProgress?: (p: number, msg: string) => void) {
    const rows = readExcelRows(fs.readFileSync(excelPath));
    const lines = buildLineDrafts(rows);
    return this.generateFromLines(record, lines, user, orderTypeScope, onProgress);
  }

  async generateFromLines(
    record: BasketGenerationRecord,
    lines: LineDraft[],
    user: User,
    orderTypeScope: string,
    onProgress?: (p: number, msg: string) => void,
    ownerUserId?: string,
  ) {
    onProgress?.(25, `读取到 ${lines.length} 行明细，开始解析`);
    const ctx = await this.buildContext(user, orderTypeScope, ownerUserId);
    await analyzeAll(lines, ctx);
    onProgress?.(45, '解析完成，开始排版测量');
    const output = await runPipeline(lines, ctx, { shopName: user.shopName || '', processDate: dayjs().format('YYYY-MM-DD') }, (req) => this.python(req), { skipAnalyze: true });
    onProgress?.(80, '生成制作文件');

    let webPath: string | null = null;
    if (output.pptBase64) {
      const stamp = Date.now();
      const pptName = `basket_orders_${stamp}.pptx`;
      const excelBuffer = await this.buildExportExcel(output.lines, ctx, user.shopName || '');
      const zip = new AdmZip();
      zip.addFile(pptName, Buffer.from(output.pptBase64, 'base64'));
      zip.addFile(`orders_export_${stamp}.xlsx`, excelBuffer);
      const zipName = `order_package_${stamp}.zip`;
      zip.writeZip(path.resolve(this.uploadsDir, zipName));
      webPath = `/uploads/baskets/${zipName}`;
    }
    await this.persistLines(record.id, record.userId, output.lines);
    return { output, webPath };
  }

  async persistLines(recordId: number, userId: string | null, lines: LineDraft[]) {
    // 已被补处理记录取代的明细保留原样（它们的订单已经在新记录里生成），不删除、不重做
    await this.lineRepo.createQueryBuilder().delete().where('record_id = :recordId', { recordId }).andWhere('superseded_by_record_id IS NULL').execute();
    const idByRow = new Map<number, number>();
    const entities = lines.map((l) =>
      this.lineRepo.create({
        recordId,
        userId,
        rowIndex: l.rowIndex,
        orderId: l.orderId,
        transactionId: l.transactionId,
        sku: l.sku,
        itemName: l.itemName,
        quantity: l.quantity,
        quantityRaw: l.quantityRaw,
        variationsRaw: l.variationsRaw,
        noteRaw: l.noteRaw,
        shipName: l.shipName,
        orderDate: l.orderDate,
        datePaid: l.datePaid,
        rawRow: l.rawRow,
        dedupeKey: l.dedupeKey,
        duplicateOfLineId: null,
        matchStatus: l.matchStatus,
        skuConfigId: l.skuConfigId,
        matchedSku: l.matchedSku,
        matchNote: l.matchNote,
        produceMode: l.produceMode,
        parseSource: l.parse?.source || null,
        parseResult: l.parse,
        manualOverride: l.manualOverride || null,
        status: l.status,
        exceptionCategory: l.exceptionCategory,
        reviewReasons: l.reasons,
        warnings: l.warnings,
        units: l.units.map((u: any) => ({
          ...u,
          icons: u.icons.map((i: any) => ({ raw: i.raw, iconId: i.iconId, iconName: i.iconName, kind: i.kind, filePath: i.filePath, fileExists: i.fileExists, position: i.position, slot: i.slot?.key || null })),
        })),
        expectedUnits: l.expectedUnits,
        producedUnits: l.status === 'produced' || l.status === 'failed' ? l.producedUnits : 0,
        producedSlides: l.producedSlides,
        reminderText: l.reminderText,
        orderHasPages: l.orderHasPages,
        sourceLineId: (l as any).sourceLineId ?? null,
      }),
    );
    for (let i = 0; i < entities.length; i += 200) {
      const saved = await this.lineRepo.save(entities.slice(i, i + 200));
      saved.forEach((s) => idByRow.set(s.rowIndex, s.id));
    }
    const dupUpdates = lines.filter((l) => l.duplicateOfRowIndex);
    for (const l of dupUpdates) {
      await this.lineRepo.update({ recordId, rowIndex: l.rowIndex }, { duplicateOfLineId: idByRow.get(l.duplicateOfRowIndex!) ?? null });
    }
  }

  private async buildExportExcel(lines: LineDraft[], ctx: PipelineContext, shopName: string): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('订单导出');
    sheet.columns = [
      { header: '订单号', key: 'orderId', width: 20 },
      { header: '序号', key: 'pos', width: 10 },
      { header: '全局页', key: 'slide', width: 8 },
      { header: '下单时间', key: 'orderDate', width: 16 },
      { header: '顾客姓名', key: 'shipName', width: 18 },
      { header: '产品数量', key: 'quantity', width: 10 },
      { header: '组成件', key: 'component', width: 14 },
      { header: '制作名字', key: 'name', width: 18 },
      { header: '图标', key: 'icons', width: 18 },
      { header: '颜色', key: 'color', width: 18 },
      { header: '自定义信息', key: 'customInfo', width: 50 },
      { header: 'SKU', key: 'sku', width: 20 },
      { header: '连单提醒', key: 'reminder', width: 30 },
      { header: '二维码', key: 'qrcode', width: 16 },
      { header: '店铺名', key: 'shopName', width: 16 },
    ];
    for (const line of lines) {
      if (line.status !== 'produced' && line.status !== 'failed') continue;
      for (const unit of line.units) {
        if (!unit.slideNumber) continue;
        const row = sheet.addRow({
          orderId: line.orderId,
          pos: unit.groupPosition,
          slide: unit.slideNumber,
          orderDate: line.datePaid || line.orderDate || '',
          shipName: line.shipName || '',
          quantity: line.quantity,
          component: unit.component || '',
          name: unit.name || '',
          icons: unit.icons.map((i) => i.iconName).join(', '),
          color: [unit.colorRaw, unit.colorMapped].filter(Boolean).join(' → '),
          customInfo: line.variationsRaw,
          sku: line.sku,
          reminder: line.reminderText || '',
          shopName,
        });
        row.height = 70;
        try {
          const img = wb.addImage({ buffer: (await generateQrBuffer(String(line.orderId || ''))) as any, extension: 'png' });
          sheet.addImage(img, { tl: { col: 13 + 0.1, row: row.number - 1 + 0.1 }, ext: { width: 70, height: 70 }, editAs: 'oneCell' } as any);
        } catch {}
      }
    }
    const notGenerated = wb.addWorksheet('未生成');
    notGenerated.columns = [
      { header: '行号', key: 'row', width: 8 },
      { header: '订单号', key: 'orderId', width: 20 },
      { header: 'SKU', key: 'sku', width: 24 },
      { header: '数量', key: 'q', width: 8 },
      { header: '状态', key: 'status', width: 18 },
      { header: '原因', key: 'reason', width: 60 },
      { header: '自定义信息', key: 'v', width: 50 },
    ];
    for (const line of lines) {
      if (line.status === 'produced') continue;
      notGenerated.addRow({
        row: line.rowIndex,
        orderId: line.orderId,
        sku: line.sku,
        q: line.quantity,
        status: LINE_STATUS_LABELS[line.status] || line.status,
        reason: [...line.reasons, ...line.warnings.filter((w) => w.code === 'out_of_scope')].map((r) => r.message).join('；') || (line.duplicateOfRowIndex ? `与第 ${line.duplicateOfRowIndex} 行完全相同` : ''),
        v: line.variationsRaw,
      });
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  // ================================================================ 明细 / 异常清单

  private applyLineFilters(qb, user: User, query: LineQuery) {
    if (!user.isAdmin) qb.andWhere('line.userId = :uid', { uid: user.id });
    if (query.recordId) qb.andWhere('line.recordId = :recordId', { recordId: Number(query.recordId) });
    if (query.orderId) qb.andWhere('line.orderId = :orderId', { orderId: String(query.orderId).trim() });
    if (query.sku) qb.andWhere('line.sku ILIKE :sku', { sku: `%${query.sku.trim()}%` });
    if (query.status) qb.andWhere('line.status = :status', { status: query.status });
    if (query.category) qb.andWhere('line.exceptionCategory = :category', { category: query.category });
    if (query.orderNoPages) qb.andWhere('line.orderHasPages = false');
    if (query.search?.trim()) {
      const term = `%${query.search.trim()}%`;
      qb.andWhere(new Brackets((b) => {
        b.where('line.orderId ILIKE :term', { term })
          .orWhere('line.sku ILIKE :term', { term })
          .orWhere('line.variationsRaw ILIKE :term', { term })
          .orWhere('line.noteRaw ILIKE :term', { term });
      }));
    }
    if (query.onlyExceptions) {
      qb.andWhere('line.exceptionCategory IS NOT NULL');
      if (!query.includeResolved) qb.andWhere('line.resolution IS NULL').andWhere('line.supersededByRecordId IS NULL');
    }
    if (query.startDate) qb.andWhere('line.createdAt >= :sd', { sd: new Date(`${query.startDate}T00:00:00`) });
    if (query.endDate) qb.andWhere('line.createdAt <= :ed', { ed: new Date(`${query.endDate}T23:59:59`) });
  }

  async listLines(user: User, query: LineQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(500, Math.max(1, Number(query.limit) || 20));
    const qb = this.lineRepo.createQueryBuilder('line')
      .leftJoin(BasketGenerationRecord, 'record', 'record.id = line.recordId')
      .addSelect(['record.originalFilename', 'record.createdAt'])
      .orderBy('line.recordId', 'DESC')
      .addOrderBy('line.rowIndex', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);
    this.applyLineFilters(qb, user, query);
    const [items, total] = await qb.getManyAndCount();
    const records = await this.recordRepo.find({ where: { id: In([...new Set(items.map((i) => i.recordId))]) }, select: ['id', 'originalFilename', 'createdAt'] });
    const recordById = new Map(records.map((r) => [r.id, r]));
    return {
      items: items.map((i) => ({
        ...i,
        statusLabel: LINE_STATUS_LABELS[i.status] || i.status,
        categoryLabel: i.exceptionCategory ? EXCEPTION_CATEGORY_LABELS[i.exceptionCategory] || i.exceptionCategory : null,
        recordFilename: recordById.get(i.recordId)?.originalFilename,
        recordCreatedAt: recordById.get(i.recordId)?.createdAt,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async exceptionSummary(user: User, query: LineQuery) {
    const qb = this.lineRepo.createQueryBuilder('line').select('line.exceptionCategory', 'category').addSelect('COUNT(*)', 'count').groupBy('line.exceptionCategory');
    this.applyLineFilters(qb, user, { ...query, onlyExceptions: true, category: undefined });
    const rows = await qb.getRawMany();
    const noPages = this.lineRepo.createQueryBuilder('line').select('COUNT(DISTINCT line.orderId)', 'count');
    this.applyLineFilters(noPages, user, { ...query, onlyExceptions: true, orderNoPages: true, category: undefined });
    const np = await noPages.getRawOne();
    return {
      categories: rows.map((r) => ({ category: r.category, label: EXCEPTION_CATEGORY_LABELS[r.category] || r.category, count: Number(r.count) })),
      ordersWithoutPages: Number(np?.count || 0),
      labels: EXCEPTION_CATEGORY_LABELS,
    };
  }

  async exportExceptions(user: User, query: LineQuery): Promise<Buffer> {
    const { items } = await this.listLines(user, { ...query, onlyExceptions: true, page: 1, limit: 500 });
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('异常清单');
    sheet.columns = [
      { header: '上传文件', key: 'file', width: 24 },
      { header: '行号', key: 'row', width: 8 },
      { header: '订单号', key: 'orderId', width: 18 },
      { header: '整单无页', key: 'noPages', width: 10 },
      { header: 'SKU', key: 'sku', width: 24 },
      { header: '数量', key: 'q', width: 8 },
      { header: '异常类别', key: 'cat', width: 18 },
      { header: '状态', key: 'status', width: 14 },
      { header: '原因', key: 'reason', width: 60 },
      { header: 'Variations 原文', key: 'v', width: 50 },
      { header: 'NOTE 原文', key: 'note', width: 30 },
    ];
    for (const i of items) {
      sheet.addRow({
        file: i.recordFilename,
        row: i.rowIndex,
        orderId: i.orderId,
        noPages: i.orderHasPages ? '' : '是',
        sku: i.sku,
        q: i.quantity,
        cat: i.categoryLabel,
        status: i.statusLabel,
        reason: (i.reviewReasons || []).filter((r: any) => r.severity === 'blocking').map((r: any) => r.message).join('；'),
        v: i.variationsRaw,
        note: i.noteRaw || '',
      });
    }
    sheet.getColumn('v').alignment = { wrapText: true, vertical: 'top' };
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  private async getOwnedLine(id: number, user: User): Promise<BasketOrderLine> {
    const line = await this.lineRepo.findOne({ where: { id } });
    if (!line) throw new NotFoundException(`明细 ${id} 不存在`);
    if (!user.isAdmin && line.userId !== user.id) throw new ForbiddenException('无权访问该明细');
    return line;
  }

  async getLine(id: number, user: User) {
    const line = await this.getOwnedLine(id, user);
    const siblings = await this.lineRepo.find({ where: { recordId: line.recordId, orderId: line.orderId }, order: { rowIndex: 'ASC' } });
    const refImages = line.skuConfigId ? await this.effectiveReferenceImages(line.skuConfigId) : [];
    return {
      ...line,
      statusLabel: LINE_STATUS_LABELS[line.status] || line.status,
      categoryLabel: line.exceptionCategory ? EXCEPTION_CATEGORY_LABELS[line.exceptionCategory] : null,
      orderLines: siblings.map((s) => ({ id: s.id, rowIndex: s.rowIndex, sku: s.sku, quantity: s.quantity, status: s.status, statusLabel: LINE_STATUS_LABELS[s.status] || s.status, producedUnits: s.producedUnits })),
      referenceImages: refImages,
    };
  }

  /** 人工指定名字 / 图标（逐件），只影响这一行；保存后需要重处理 / 重新生成 */
  async setManualOverride(id: number, user: User, override: ManualOverride | null) {
    const line = await this.getOwnedLine(id, user);
    if (override) {
      if (!Array.isArray(override.units) || !override.units.length) throw new BadRequestException('请逐件填写名字 / 图标');
      for (const u of override.units) {
        if (u.name !== null && u.name !== undefined && typeof u.name !== 'string') throw new BadRequestException('名字格式错误');
      }
    }
    line.manualOverride = override;
    await this.lineRepo.save(line);
    return this.reprocessLines([id], user);
  }

  async resolveLine(id: number, user: User, resolution: string | null, note?: string) {
    const line = await this.getOwnedLine(id, user);
    if (resolution && !['ignored'].includes(resolution)) throw new BadRequestException('resolution 只能是 ignored 或空');
    line.resolution = resolution;
    line.resolutionNote = note || null;
    line.resolvedAt = resolution ? new Date() : null;
    await this.lineRepo.save(line);
    return line;
  }

  // ================================================================ 重处理

  private entityToDraft(e: BasketOrderLine): LineDraft {
    return {
      rowIndex: e.rowIndex,
      orderId: e.orderId,
      transactionId: e.transactionId,
      sku: e.sku,
      itemName: e.itemName,
      quantity: e.quantity,
      quantityRaw: e.quantityRaw || String(e.quantity),
      variationsRaw: e.variationsRaw,
      noteRaw: e.noteRaw,
      shipName: e.shipName,
      orderDate: e.orderDate,
      datePaid: e.datePaid,
      shipState: null,
      shipAddress: null,
      rawRow: e.rawRow || {},
      dedupeKey: e.dedupeKey,
      duplicateOfRowIndex: null,
      matchStatus: 'none',
      skuConfigId: null,
      matchedSku: null,
      matchNote: null,
      produceMode: null,
      parse: null,
      manualOverride: e.manualOverride || null,
      units: [],
      status: e.status === 'duplicate' ? 'duplicate' : 'pending',
      exceptionCategory: null,
      reasons: [],
      warnings: [],
      expectedUnits: 0,
      producedUnits: 0,
      producedSlides: [],
      reminderText: null,
      orderHasPages: false,
    };
  }

  /**
   * 只重新匹配 SKU 和解析（不生成 PPT），用于修改配置后预览结果。
   * 已生成的行不改变状态（它们的页已经在 PPT 里），只更新待处理 / 异常行。
   */
  async reprocessLines(ids: number[], user: User) {
    if (!ids?.length) throw new BadRequestException('请选择明细');
    const lines = await this.lineRepo.find({ where: { id: In(ids) } });
    const results: any[] = [];
    const byOwner = new Map<string, BasketOrderLine[]>();
    for (const l of lines) {
      if (!user.isAdmin && l.userId !== user.id) throw new ForbiddenException('无权访问该明细');
      const key = l.userId || user.id;
      if (!byOwner.has(key)) byOwner.set(key, []);
      byOwner.get(key)!.push(l);
    }
    for (const [ownerId, group] of byOwner) {
      const record = await this.recordRepo.findOne({ where: { id: group[0].recordId } });
      const ctx = await this.buildContext(user, record?.orderType && record.orderType !== 'basket' ? record.orderType : 'all', ownerId);
      for (const entity of group) {
        if (entity.status === 'duplicate') {
          results.push({ id: entity.id, status: entity.status });
          continue;
        }
        const draft = this.entityToDraft(entity);
        await analyzeAll([draft], ctx);
        const keepProduced = entity.status === 'produced';
        Object.assign(entity, {
          matchStatus: draft.matchStatus,
          skuConfigId: draft.skuConfigId,
          matchedSku: draft.matchedSku,
          matchNote: draft.matchNote,
          produceMode: draft.produceMode,
          parseSource: draft.parse?.source || null,
          parseResult: draft.parse,
          reviewReasons: draft.reasons,
          warnings: draft.warnings,
          exceptionCategory: keepProduced ? null : draft.exceptionCategory || (draft.status === 'pending' ? 'ready_to_regenerate' : null),
          status: keepProduced ? entity.status : draft.status === 'pending' ? 'ready' : draft.status,
          units: keepProduced ? entity.units : draft.units.map((u: any) => ({ ...u, icons: u.icons.map((i: any) => ({ ...i, slot: i.slot?.key || null })) })),
          expectedUnits: draft.expectedUnits,
        });
        await this.lineRepo.save(entity);
        results.push({ id: entity.id, status: entity.status, exceptionCategory: entity.exceptionCategory, reasons: draft.reasons.map((r) => r.message) });
      }
    }
    return { items: results };
  }

  /** 按保存的明细重新生成某条记录的 PPT（不需要重新上传）。旧文件保留在 previousOutputs 中作为备份 */
  async regenerateRecord(recordId: number, user: User) {
    const record = await this.recordRepo.findOne({ where: { id: recordId }, relations: ['user'] });
    if (!record) throw new NotFoundException(`记录 ${recordId} 不存在`);
    if (!user.isAdmin && record.userId !== user.id) throw new ForbiddenException('无权访问该记录');
    const all = await this.lineRepo.find({ where: { recordId }, order: { rowIndex: 'ASC' } });
    if (!all.length) throw new BadRequestException('该记录没有保存明细（v2 之前的历史记录），请用"从原始文件补建明细"或重新上传');
    // 已补处理到新记录的订单不再在原记录里重复生成
    const entities = all.filter((e) => !e.supersededByRecordId);
    const resolutions = new Map(entities.filter((e) => e.resolution).map((e) => [e.rowIndex, { resolution: e.resolution, resolutionNote: e.resolutionNote, resolvedAt: e.resolvedAt }]));
    const drafts = this.draftsWithDuplicates(entities);
    const owner = record.user || user;
    const { output, webPath } = await this.generateFromLines(record, drafts, { ...owner, isAdmin: user.isAdmin } as User, record.orderType === 'basket' ? 'all' : record.orderType || 'all', undefined, record.userId || undefined);
    for (const [rowIndex, r] of resolutions) {
      await this.lineRepo.update({ recordId, rowIndex, supersededByRecordId: null as any }, r as any);
    }
    const previous = [...(record.previousOutputs || [])];
    if (record.outputFilePath) previous.push({ outputFilePath: record.outputFilePath, replacedAt: new Date().toISOString() });
    await this.recordRepo.update(recordId, {
      outputFilePath: webPath,
      previousOutputs: previous as any,
      ...this.recordStats(output),
    });
    return { recordId, outputFilePath: webPath, stats: output.stats };
  }

  private draftsWithDuplicates(entities: BasketOrderLine[]): LineDraft[] {
    const rowById = new Map(entities.map((e) => [e.id, e.rowIndex]));
    return entities.map((e) => {
      const d = this.entityToDraft(e);
      if (e.status === 'duplicate') d.duplicateOfRowIndex = e.duplicateOfLineId ? rowById.get(e.duplicateOfLineId) ?? null : null;
      (d as any).sourceLineId = e.sourceLineId;
      return d;
    });
  }

  recordStats(output: any) {
    const orderIds = Array.from(new Set(output.lines.filter((l) => l.status === 'produced').map((l) => l.orderId).filter(Boolean)));
    const skus = Array.from(new Set(output.lines.filter((l) => l.status === 'produced').map((l) => l.sku).filter(Boolean)));
    return {
      linesTotal: output.stats.linesTotal,
      unitsProduced: output.stats.unitsProduced,
      exceptionCount: output.stats.exceptionLines,
      warningCount: output.stats.warningLines,
      ordersProcessed: output.stats.unitsProduced,
      totalOrders: output.lines.length,
      orderIds: orderIds as string[],
      skus: skus as string[],
      pipelineVersion: PIPELINE_VERSION,
    };
  }

  /**
   * 补处理：选中若干明细（通常来自异常清单），把它们所在订单的全部明细复制到一条新的生成记录里重新生成。
   * 原明细标记为已被新记录取代，离开异常清单；新记录里仍未解决的会重新出现在异常清单。
   */
  async regenerateForLines(ids: number[], user: User) {
    if (!ids?.length) throw new BadRequestException('请选择明细');
    const selected = await this.lineRepo.find({ where: { id: In(ids) } });
    if (!selected.length) throw new NotFoundException('明细不存在');
    const owners = new Set(selected.map((l) => l.userId));
    if (owners.size > 1) throw new BadRequestException('一次补处理只能选择同一个账号的明细');
    for (const l of selected) if (!user.isAdmin && l.userId !== user.id) throw new ForbiddenException('无权访问该明细');
    const ownerId = selected[0].userId || user.id;
    const pairs = new Set(selected.map((l) => `${l.recordId}\u0001${l.orderId}`));
    const all: BasketOrderLine[] = [];
    for (const pair of pairs) {
      const [recordId, orderId] = pair.split('\u0001');
      all.push(...(await this.lineRepo.find({ where: { recordId: Number(recordId), orderId }, order: { rowIndex: 'ASC' } })));
    }
    const sourceRecordIds = [...new Set(all.map((l) => l.recordId))];
    const firstRecord = await this.recordRepo.findOne({ where: { id: sourceRecordIds[0] }, relations: ['user'] });
    const record = await this.recordRepo.save(this.recordRepo.create({
      originalFilename: `补处理-${firstRecord?.originalFilename || ''}`.slice(0, 250),
      status: 'processing',
      progress: 10,
      userId: ownerId,
      orderType: firstRecord?.orderType || 'all',
      reprocessOfRecordId: sourceRecordIds.length === 1 ? sourceRecordIds[0] : null,
    }));
    try {
      // 新记录里重新编号行号，保持原顺序
      const drafts = this.draftsWithDuplicates(all).map((d, i) => ({ ...d, rowIndex: i + 2, sourceLineId: all[i].id }) as any);
      const rowMap = new Map(all.map((e, i) => [e.rowIndex + ':' + e.recordId, i + 2]));
      drafts.forEach((d: any, i) => {
        if (all[i].duplicateOfLineId) {
          const src = all.find((x) => x.id === all[i].duplicateOfLineId);
          d.duplicateOfRowIndex = src ? rowMap.get(src.rowIndex + ':' + src.recordId) ?? null : null;
        }
      });
      const owner = firstRecord?.user || user;
      const { output, webPath } = await this.generateFromLines(record, drafts, { ...owner, isAdmin: user.isAdmin } as User, record.orderType === 'basket' ? 'all' : record.orderType, undefined, ownerId);
      await this.recordRepo.update(record.id, { status: 'completed', progress: 100, outputFilePath: webPath, ...this.recordStats(output) });
      await this.lineRepo.update({ id: In(all.map((l) => l.id)) }, { supersededByRecordId: record.id, resolution: 'reprocessed', resolvedAt: new Date() });
      return { recordId: record.id, outputFilePath: webPath, stats: output.stats };
    } catch (error) {
      await this.recordRepo.update(record.id, { status: 'failed', progress: 0, errorMessage: (error as Error).message });
      throw error;
    }
  }

  /**
   * 历史记录补建明细：v2 之前的记录没有明细，如果原始上传文件还在服务器上，可以从文件补建（只分析，不重新生成 PPT），
   * 之后可以在明细页查看 NOTE 原文、异常，并按需补处理。
   */
  async backfillRecordLines(recordId: number, user: User, sourceFilePath?: string) {
    const record = await this.recordRepo.findOne({ where: { id: recordId }, relations: ['user'] });
    if (!record) throw new NotFoundException(`记录 ${recordId} 不存在`);
    if (!user.isAdmin && record.userId !== user.id) throw new ForbiddenException('无权访问该记录');
    const filePath = sourceFilePath || record.sourceFilePath;
    if (!filePath || !this.fileExists(filePath)) {
      throw new BadRequestException('找不到该记录的原始上传文件，无法补建明细');
    }
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath.replace(/^\//, ''));
    if (!path.resolve(resolved).startsWith(path.resolve(process.cwd(), 'uploads', 'baskets'))) {
      throw new BadRequestException('原始文件必须位于 uploads/baskets 下');
    }
    const lines = buildLineDrafts(readExcelRows(fs.readFileSync(resolved)));
    const ctx = await this.buildContext({ ...(record.user || user), isAdmin: user.isAdmin } as User, record.orderType === 'basket' ? 'all' : record.orderType || 'all', record.userId || undefined);
    await analyzeAll(lines, ctx);
    for (const l of lines) if (l.status === 'pending') (l as any).status = 'backfilled';
    await this.persistLines(record.id, record.userId, lines);
    await this.recordRepo.update(record.id, { sourceFilePath: filePath, linesTotal: lines.length });
    return { recordId, lines: lines.length };
  }

  // ================================================================ 图标布局模板

  async listTemplates(user: User) {
    const where = user.isAdmin ? { isActive: true } : { userId: user.id, isActive: true };
    const templates = await this.templateRepo.find({ where, order: { id: 'ASC' } });
    const usage = await this.skuConfigRepo.createQueryBuilder('c')
      .select('c.iconLayoutTemplateId', 'tid').addSelect('COUNT(*)', 'n').addSelect('array_agg(c.sku)', 'skus')
      .where('c.iconLayoutTemplateId IS NOT NULL').groupBy('c.iconLayoutTemplateId').getRawMany();
    const byId = new Map(usage.map((u) => [Number(u.tid), u]));
    return templates.map((t) => ({ ...t, boundSkuCount: Number(byId.get(t.id)?.n || 0), boundSkus: (byId.get(t.id)?.skus || []).slice(0, 50) }));
  }

  async saveTemplate(user: User, dto: any, id?: number) {
    const errors = validateTemplate({ slots: dto.slots || [], rules: dto.rules || [], defaultOrder: dto.defaultOrder || [] });
    if (!dto.name?.trim()) errors.unshift('模板名称不能为空');
    if (errors.length) throw new BadRequestException(errors.join('；'));
    let entity: BasketIconLayoutTemplate;
    if (id) {
      entity = await this.templateRepo.findOne({ where: { id } });
      if (!entity || (!user.isAdmin && entity.userId !== user.id)) throw new NotFoundException(`模板 ${id} 不存在`);
    } else {
      entity = this.templateRepo.create({ userId: user.id });
    }
    entity.name = dto.name.trim();
    entity.description = dto.description || null;
    entity.slots = dto.slots || [];
    entity.rules = dto.rules || [];
    entity.defaultOrder = dto.defaultOrder || [];
    return this.templateRepo.save(entity);
  }

  async deleteTemplate(user: User, id: number) {
    const entity = await this.templateRepo.findOne({ where: { id } });
    if (!entity || (!user.isAdmin && entity.userId !== user.id)) throw new NotFoundException(`模板 ${id} 不存在`);
    const bound = await this.skuConfigRepo.count({ where: { iconLayoutTemplateId: id } });
    if (bound) throw new BadRequestException(`该模板仍被 ${bound} 个 SKU 使用，请先解除绑定`);
    entity.isActive = false;
    await this.templateRepo.save(entity);
  }

  // ================================================================ SKU 复制

  static readonly COPY_FIELDS = [
    'type', 'replaceValue', 'fontSize', 'font', 'yarnColorMap', 'comboItems', 'colorGroupId', 'iconGroupId', 'comboOverridesJson',
    'externalOrderReminderEnabled', 'externalOrderReminderContent', 'produceMode', 'iconLayoutTemplateId', 'maxIcons', 'nameLayout', 'referenceGroupKey',
  ] as const;

  async copySkuConfig(id: number, user: User, newSku: string, overrides: Record<string, any> = {}) {
    const source = await this.skuConfigRepo.findOne({ where: user.isAdmin ? { id } : { id, userId: user.id } });
    if (!source) throw new NotFoundException(`SKU配置ID ${id} 不存在`);
    const sku = String(newSku || '').trim();
    if (!sku) throw new BadRequestException('请填写新 SKU');
    const exists = await this.skuConfigRepo.findOne({ where: { userId: source.userId, sku } });
    if (exists) throw new BadRequestException(`SKU ${sku} 已存在配置，不能重名`);
    const copy: any = { userId: source.userId, sku, copiedFromId: source.id };
    for (const f of BasketLinesService.COPY_FIELDS) {
      const v = (source as any)[f];
      copy[f] = v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
    }
    for (const [k, v] of Object.entries(overrides || {})) {
      if ((BasketLinesService.COPY_FIELDS as readonly string[]).includes(k)) copy[k] = v;
    }
    const saved = await this.skuConfigRepo.save(this.skuConfigRepo.create(copy));
    // 参考图：复制关联（共用组 key 已随配置复制；该 SKU 单独的参考图复制为新记录，文件共用）
    const ownImages = await this.refImageRepo.find({ where: { skuConfigId: source.id, isActive: true } });
    for (const img of ownImages) {
      await this.refImageRepo.save(this.refImageRepo.create({ ...img, id: undefined, skuConfigId: (saved as any).id, createdAt: undefined, updatedAt: undefined }));
    }
    return saved;
  }

  // ================================================================ 参考图

  async effectiveReferenceImages(skuConfigId: number) {
    const config = await this.skuConfigRepo.findOne({ where: { id: skuConfigId } });
    if (!config) return [];
    const own = await this.refImageRepo.find({ where: { skuConfigId, isActive: true }, order: { sortOrder: 'ASC', id: 'ASC' } });
    if (own.length) return own.map((i) => ({ ...i, source: 'sku' }));
    if (!config.referenceGroupKey) return [];
    const shared = await this.refImageRepo.find({ where: { userId: config.userId, groupKey: config.referenceGroupKey, skuConfigId: null as any, isActive: true }, order: { sortOrder: 'ASC', id: 'ASC' } });
    return shared.map((i) => ({ ...i, source: 'group' }));
  }

  async listReferenceImages(user: User, query: { skuConfigId?: number; groupKey?: string }) {
    if (query.skuConfigId) {
      const config = await this.skuConfigRepo.findOne({ where: { id: Number(query.skuConfigId) } });
      if (!config || (!user.isAdmin && config.userId !== user.id)) throw new NotFoundException('SKU 配置不存在');
      const own = await this.refImageRepo.find({ where: { skuConfigId: config.id, isActive: true }, order: { sortOrder: 'ASC', id: 'ASC' } });
      const shared = config.referenceGroupKey
        ? await this.refImageRepo.find({ where: { userId: config.userId, groupKey: config.referenceGroupKey, skuConfigId: null as any, isActive: true }, order: { sortOrder: 'ASC', id: 'ASC' } })
        : [];
      return { own, shared, groupKey: config.referenceGroupKey, effective: own.length ? 'sku' : shared.length ? 'group' : 'none' };
    }
    if (query.groupKey) {
      const where: any = { groupKey: query.groupKey, skuConfigId: null, isActive: true };
      if (!user.isAdmin) where.userId = user.id;
      return { own: [], shared: await this.refImageRepo.find({ where, order: { sortOrder: 'ASC', id: 'ASC' } }), groupKey: query.groupKey, effective: 'group' };
    }
    const where: any = { isActive: true };
    if (!user.isAdmin) where.userId = user.id;
    const groups = await this.refImageRepo.createQueryBuilder('i').select('i.groupKey', 'groupKey').addSelect('COUNT(*)', 'count')
      .where('i.isActive = true').andWhere('i.groupKey IS NOT NULL').andWhere('i.skuConfigId IS NULL')
      .andWhere(user.isAdmin ? '1=1' : 'i.userId = :uid', { uid: user.id }).groupBy('i.groupKey').getRawMany();
    return { groups };
  }

  async addReferenceImage(user: User, file: Express.Multer.File, dto: { skuConfigId?: number; groupKey?: string; caption?: string; replaceId?: number }) {
    if (!file) throw new BadRequestException('请上传图片');
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.mimetype)) throw new BadRequestException('只支持 png / jpg / webp / gif 图片');
    let ownerId = user.id;
    let skuConfigId: number | null = null;
    let groupKey: string | null = dto.groupKey?.trim() || null;
    if (dto.skuConfigId) {
      const config = await this.skuConfigRepo.findOne({ where: { id: Number(dto.skuConfigId) } });
      if (!config || (!user.isAdmin && config.userId !== user.id)) throw new NotFoundException('SKU 配置不存在');
      ownerId = config.userId;
      skuConfigId = config.id;
      groupKey = null;
    } else if (!groupKey) {
      throw new BadRequestException('请指定 SKU 或母体分组');
    }
    const filePath = `/uploads/baskets/reference/${file.filename}`;
    if (dto.replaceId) {
      const existing = await this.refImageRepo.findOne({ where: { id: Number(dto.replaceId) } });
      if (!existing || (!user.isAdmin && existing.userId !== user.id)) throw new NotFoundException('参考图不存在');
      existing.fileName = file.originalname;
      existing.filePath = filePath;
      existing.mimeType = file.mimetype;
      if (dto.caption !== undefined) existing.caption = dto.caption;
      return this.refImageRepo.save(existing);
    }
    const count = await this.refImageRepo.count({ where: skuConfigId ? { skuConfigId, isActive: true } : { groupKey, userId: ownerId, isActive: true } as any });
    return this.refImageRepo.save(this.refImageRepo.create({
      userId: ownerId, skuConfigId, groupKey, fileName: file.originalname, filePath, mimeType: file.mimetype, caption: dto.caption || null, sortOrder: count,
    }));
  }

  async removeReferenceImage(user: User, id: number) {
    const existing = await this.refImageRepo.findOne({ where: { id } });
    if (!existing || (!user.isAdmin && existing.userId !== user.id)) throw new NotFoundException('参考图不存在');
    existing.isActive = false;
    await this.refImageRepo.save(existing);
  }
}
