import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as ExcelJS from 'exceljs';
import * as dayjs from 'dayjs';
import { Order } from '../orders/entities/order.entity';
import { EtsyOrder } from '../orders/entities/etsy-order.entity';
import { OrderStatus } from '../orders/enums/order.enum';
import { StampGenerationRecord } from '../stamps/entities/stamp-generation-record.entity';
import { StampType } from '../stamps/entities/stamp-template.entity';
import { AppSetting } from '../common/entities/app-setting.entity';
import { User } from '../users/entities/user.entity';

/** 十列导出的字段来源。默认值是待甲方确认前的暂定方案，可在页面上修改 */
export interface RattleExportSettings {
  fileType: 'xlsx';
  /** 订单日期取：datePaid 付款日期 / saleDate 下单日期 */
  dateSource: 'datePaid' | 'saleDate';
  dateFormat: string;
  /** 客户名取：shipName 收件人 / buyer 买家 */
  customerSource: 'shipName' | 'buyer';
  /** 每行：order 一条订单明细 / unit 按数量拆成多行 */
  rowMode: 'order' | 'unit';
  /** 款式在 Variations 里的标签 */
  styleLabels: string[];
  /** 款式 → 中文名对照；没有对照的留空，不猜 */
  styleCnMap: Record<string, string>;
  /** 字体取：template 审核记录里实际使用的字体 / variation 顾客选择的字体选项 */
  fontSource: 'template' | 'variation';
  fontLabels: string[];
  /** 袋子颜色、贺卡内容在 Variations 里的标签；未配置时留空 */
  bagColorLabels: string[];
  cardLabels: string[];
}

const DEFAULT_EXPORT_SETTINGS: RattleExportSettings = {
  fileType: 'xlsx',
  dateSource: 'datePaid',
  dateFormat: 'YYYY-MM-DD',
  customerSource: 'shipName',
  rowMode: 'order',
  styleLabels: ['Rattle Style'],
  styleCnMap: {},
  fontSource: 'template',
  fontLabels: ['Font Design'],
  bagColorLabels: [],
  cardLabels: [],
};

const EXPORT_COLUMNS = ['订单日期', '订单号', '客户名', '款式', '款式中文', '定制信息', '字体', '数量', '袋子颜色', '贺卡内容'];
const SETTINGS_KEY = 'rattle_export';
const STAMPS_DIR = path.join('uploads', 'stamps');
const TRASH_DIR = path.join('uploads', 'trash', 'stamps');

export interface CleanupCandidate {
  recordId: number;
  imageUrl: string;
  kind: 'superseded' | 'blank';
  reason: string;
  isCurrent: boolean;
  fileExists: boolean;
}

/**
 * 摇铃审核后的辅助功能：
 * - R4 清理多余输出图：只清理本订单的生成图（被替换掉的历史候选图、当前列表里的空白图），
 *   人工勾选后执行；文件移到 uploads/trash 可恢复。不碰模板、背景、图标和其他订单的文件。
 * - R5 十列导出：只导出已审核通过的订单，字段来源可配置，缺失的留空不猜。
 */
@Injectable()
export class RattleReviewService {
  private readonly logger = new Logger(RattleReviewService.name);

  constructor(
    @InjectRepository(Order)
    private readonly orderRepository: Repository<Order>,
    @InjectRepository(EtsyOrder)
    private readonly etsyOrderRepository: Repository<EtsyOrder>,
    @InjectRepository(StampGenerationRecord)
    private readonly recordRepository: Repository<StampGenerationRecord>,
    @InjectRepository(AppSetting)
    private readonly settingRepository: Repository<AppSetting>,
  ) {}

  private async loadRattleOrder(orderId: string, user: User) {
    const qb = this.orderRepository.createQueryBuilder('order')
      .leftJoinAndSelect('order.etsyOrder', 'etsyOrder')
      .leftJoinAndSelect('order.template', 'template')
      .withDeleted()
      .where('order.id = :orderId', { orderId });
    if (!user.isAdmin) qb.andWhere('order.userId = :userId', { userId: user.id });
    const order = await qb.getOne();
    if (!order || !order.etsyOrder) throw new NotFoundException('订单不存在或无权访问');
    if (order.template?.type !== StampType.RATTLE) throw new BadRequestException('只能清理摇铃订单的输出图');
    return order;
  }

  /** 只允许 uploads/stamps 下的文件 */
  private stampFilePath(imageUrl: string): string | null {
    const filename = path.basename(imageUrl || '');
    if (!filename) return null;
    return path.join(process.cwd(), STAMPS_DIR, filename);
  }

  private checkBlank(files: string[]): Promise<Record<string, boolean | null>> {
    if (files.length === 0) return Promise.resolve({});
    return new Promise(resolve => {
      const python = process.env.PYTHON_EXECUTABLE?.trim() || 'python3';
      const script = path.join(process.cwd(), 'src', 'rattle', 'python', 'image_check.py');
      const child = spawn(python, [script, ...files]);
      let out = '';
      child.stdout.on('data', data => (out += data));
      child.on('close', () => {
        try {
          resolve(JSON.parse(out));
        } catch {
          resolve({});
        }
      });
      child.on('error', () => resolve({}));
    });
  }

  async getCleanupCandidates(orderId: string, user: User) {
    const order = await this.loadRattleOrder(orderId, user);
    const currentIds = new Set(order.etsyOrder.stampGenerationRecordIds || []);
    const records = await this.recordRepository.find({ where: { orderId: order.id }, order: { id: 'ASC' } });
    const active = records.filter(record => !record.cleanedAt);

    const files = active
      .map(record => this.stampFilePath(record.stampImageUrl))
      .filter((file): file is string => !!file && fs.existsSync(file));
    const blankMap = await this.checkBlank(files);

    const candidates: CleanupCandidate[] = [];
    for (const record of active) {
      const file = this.stampFilePath(record.stampImageUrl);
      const fileExists = !!file && fs.existsSync(file);
      const isCurrent = currentIds.has(record.id);
      if (!isCurrent) {
        candidates.push({ recordId: record.id, imageUrl: record.stampImageUrl, kind: 'superseded', reason: '已被替换的历史候选图（不在当前审核结果里）', isCurrent, fileExists });
      } else if (file && blankMap[file] === true) {
        candidates.push({ recordId: record.id, imageUrl: record.stampImageUrl, kind: 'blank', reason: '空白输出图（全透明或全白）', isCurrent, fileExists });
      }
    }

    return {
      orderId: order.id,
      platformOrderId: order.platformOrderId,
      status: order.status,
      canClean: order.status === OrderStatus.STAMP_GENERATED_REVIEWED,
      kept: (order.etsyOrder.stampImageUrls || []).filter(url => !candidates.some(c => c.isCurrent && c.imageUrl.endsWith(path.basename(url)))),
      candidates,
      cleaned: records.filter(record => record.cleanedAt).map(record => ({ recordId: record.id, imageUrl: record.stampImageUrl, cleanedAt: record.cleanedAt })),
    };
  }

  async previewCleanup(orderIds: string[], user: User) {
    const results = [];
    for (const orderId of orderIds || []) {
      try {
        results.push(await this.getCleanupCandidates(orderId, user));
      } catch (error) {
        results.push({ orderId, error: error.message });
      }
    }
    return results;
  }

  /** 执行清理：只处理传入的、且确实是该订单候选的记录；订单需已审核通过 */
  async cleanup(orderId: string, recordIds: number[], user: User) {
    const info = await this.getCleanupCandidates(orderId, user);
    if (!info.canClean) throw new BadRequestException('订单审核通过后才能清理输出图');
    const allowed = new Map(info.candidates.map(candidate => [candidate.recordId, candidate]));
    const targets = (recordIds || []).filter(id => allowed.has(id));
    if (targets.length === 0) return { cleaned: 0, skipped: (recordIds || []).length };

    const dayDir = path.join(process.cwd(), TRASH_DIR, dayjs().format('YYYYMMDD'));
    fs.mkdirSync(dayDir, { recursive: true });
    const etsyOrder = await this.etsyOrderRepository.findOne({ where: { order: { id: orderId } } });
    let cleaned = 0;

    for (const recordId of targets) {
      const candidate = allowed.get(recordId);
      const file = this.stampFilePath(candidate.imageUrl);
      let trashPath: string | null = null;
      if (file && fs.existsSync(file)) {
        trashPath = path.join(dayDir, path.basename(file));
        fs.renameSync(file, trashPath);
      }
      await this.recordRepository.update(recordId, {
        cleanedAt: new Date(),
        trashPath: trashPath ? path.relative(process.cwd(), trashPath) : null,
      });
      if (candidate.isCurrent && etsyOrder) {
        const index = (etsyOrder.stampGenerationRecordIds || []).indexOf(recordId);
        if (index >= 0) {
          etsyOrder.stampGenerationRecordIds = etsyOrder.stampGenerationRecordIds.filter((_, i) => i !== index);
          etsyOrder.stampImageUrls = (etsyOrder.stampImageUrls || []).filter((_, i) => i !== index);
        }
      }
      cleaned++;
    }
    if (etsyOrder) await this.etsyOrderRepository.save(etsyOrder);
    this.logger.log(`Cleaned ${cleaned} rattle images for order ${orderId} by ${user.username}`);
    return { cleaned, skipped: (recordIds || []).length - cleaned };
  }

  /** 从回收目录恢复（只恢复文件和清理标记；被移出当前列表的空白图需要时可在订单里重新生成） */
  async restore(orderId: string, recordIds: number[], user: User) {
    await this.loadRattleOrder(orderId, user);
    const records = await this.recordRepository.find({ where: { id: In(recordIds || []), orderId } });
    let restored = 0;
    for (const record of records) {
      if (!record.cleanedAt) continue;
      if (record.trashPath && fs.existsSync(path.join(process.cwd(), record.trashPath))) {
        const target = this.stampFilePath(record.stampImageUrl);
        if (target) fs.renameSync(path.join(process.cwd(), record.trashPath), target);
      }
      await this.recordRepository.update(record.id, { cleanedAt: null, trashPath: null });
      restored++;
    }
    return { restored };
  }

  async getExportSettings(): Promise<RattleExportSettings> {
    const row = await this.settingRepository.findOne({ where: { key: SETTINGS_KEY } });
    return { ...DEFAULT_EXPORT_SETTINGS, ...(row?.value || {}) };
  }

  async updateExportSettings(value: Partial<RattleExportSettings>, user: User) {
    if (!user.isAdmin) throw new ForbiddenException('只有管理员可以修改导出设置');
    const merged = { ...(await this.getExportSettings()), ...value, fileType: 'xlsx' as const };
    await this.settingRepository.save({ key: SETTINGS_KEY, value: merged, updatedBy: user.id as string });
    return merged;
  }

  /** 在解析后的 variations 里按标签取值；取不到再在原文里找"标签+值"一行；都没有返回空 */
  private variationValue(etsyOrder: EtsyOrder, labels: string[]): string {
    if (!labels?.length) return '';
    const parsed = (etsyOrder.variations && typeof etsyOrder.variations === 'object') ? etsyOrder.variations : {};
    for (const label of labels) {
      const key = Object.keys(parsed).find(k => k.trim().toLowerCase() === label.trim().toLowerCase());
      if (key && parsed[key] !== undefined && parsed[key] !== null && String(parsed[key]).trim()) {
        return String(parsed[key]);
      }
    }
    const lines = String(etsyOrder.originalVariations || '').replace(/\r\n?/g, '\n').split(/\n|,(?=[A-Z][A-Za-z ]+:)/);
    for (const label of labels) {
      const line = lines.find(l => l.trim().toLowerCase().startsWith(label.trim().toLowerCase()));
      if (line) {
        const value = line.trim().slice(label.trim().length).replace(/^\s*[:：]\s*/, '');
        if (value.trim()) return value;
      }
    }
    return '';
  }

  async exportTenColumns(
    params: { orderIds?: string[]; startDate?: string; endDate?: string },
    user: User,
  ): Promise<{ filePath: string; fileName: string; rowCount: number; orderCount: number }> {
    const settings = await this.getExportSettings();
    const qb = this.orderRepository.createQueryBuilder('order')
      .leftJoinAndSelect('order.etsyOrder', 'etsyOrder')
      .leftJoinAndSelect('order.template', 'template')
      .withDeleted()
      .where('template.type = :rattle', { rattle: StampType.RATTLE })
      .andWhere('order.status = :reviewed', { reviewed: OrderStatus.STAMP_GENERATED_REVIEWED })
      .orderBy('order.createdAt', 'ASC');
    if (params.orderIds?.length) {
      qb.andWhere('order.id IN (:...orderIds)', { orderIds: params.orderIds });
    } else {
      if (params.startDate) qb.andWhere(`date_trunc('day', "order"."createdAt") >= date_trunc('day', :startDate::timestamp)`, { startDate: params.startDate });
      if (params.endDate) qb.andWhere(`date_trunc('day', "order"."createdAt") <= date_trunc('day', :endDate::timestamp)`, { endDate: params.endDate });
    }
    if (!user.isAdmin) qb.andWhere('order.userId = :userId', { userId: user.id });
    const orders = await qb.getMany();
    if (orders.length === 0) throw new NotFoundException('没有符合条件的已审核摇铃订单');

    const recordIds = orders.flatMap(order => order.etsyOrder?.stampGenerationRecordIds || []);
    const records = recordIds.length ? await this.recordRepository.find({ where: { id: In(recordIds) } }) : [];
    const recordMap = new Map(records.map(record => [record.id, record]));

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('摇铃订单');
    sheet.columns = EXPORT_COLUMNS.map(header => ({ header, key: header, width: header === '定制信息' ? 40 : 18 }));
    sheet.getRow(1).font = { bold: true };

    let rowCount = 0;
    for (const order of orders) {
      const etsyOrder = order.etsyOrder;
      const current = (etsyOrder.stampGenerationRecordIds || []).map(id => recordMap.get(id)).filter(Boolean) as StampGenerationRecord[];
      // 定制信息、字体与审核记录（当前生成记录）一致
      const customization = current
        .map(record => (record.textElements || []).map(el => el.value).filter(v => v && String(v).trim()).join('\n'))
        .filter(Boolean)
        .join('\n\n');
      const fonts = settings.fontSource === 'template'
        ? Array.from(new Set(current.flatMap(record => (record.textElements || []).filter(el => el.value && String(el.value).trim()).map(el => el.fontFamily).filter(Boolean)))).join('、')
        : this.variationValue(etsyOrder, settings.fontLabels);
      const style = this.variationValue(etsyOrder, settings.styleLabels);
      const styleCn = style ? (settings.styleCnMap[style] ?? settings.styleCnMap[style.trim()] ?? '') : '';
      const rawDate = settings.dateSource === 'saleDate' ? etsyOrder.saleDate : etsyOrder.datePaid;
      const quantity = etsyOrder.quantity ?? null;
      const base = {
        订单日期: rawDate ? dayjs(rawDate).format(settings.dateFormat || 'YYYY-MM-DD') : '',
        订单号: order.platformOrderId || etsyOrder.orderId || '',
        客户名: (settings.customerSource === 'buyer' ? etsyOrder.buyer : etsyOrder.shipName) || '',
        款式: style,
        款式中文: styleCn,
        定制信息: customization,
        字体: fonts || '',
        数量: quantity ?? '',
        袋子颜色: this.variationValue(etsyOrder, settings.bagColorLabels),
        贺卡内容: this.variationValue(etsyOrder, settings.cardLabels),
      };
      const copies = settings.rowMode === 'unit' && quantity && quantity > 1 ? quantity : 1;
      for (let i = 0; i < copies; i++) {
        const row = sheet.addRow(copies > 1 ? { ...base, 数量: 1 } : base);
        row.getCell('定制信息').alignment = { wrapText: true, vertical: 'top' };
        row.getCell('贺卡内容').alignment = { wrapText: true, vertical: 'top' };
        rowCount++;
      }
    }

    const exportDir = path.join(process.cwd(), 'uploads', 'exports');
    fs.mkdirSync(exportDir, { recursive: true });
    const fileName = `rattle_10col_${dayjs().format('YYYYMMDD_HHmmss')}.xlsx`;
    const filePath = path.join('uploads', 'exports', fileName);
    await workbook.xlsx.writeFile(path.join(process.cwd(), filePath));
    return { filePath, fileName, rowCount, orderCount: orders.length };
  }
}
