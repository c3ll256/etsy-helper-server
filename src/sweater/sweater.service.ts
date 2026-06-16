import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as fs from 'fs';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { AliyunService } from '../common/services/aliyun.service';
import { JobQueueService } from '../common/services/job-queue.service';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';
import { User } from '../users/entities/user.entity';
import { ColorGroup } from '../basket/entities/color-group.entity';
import { ColorKv } from '../basket/entities/color-kv.entity';
import { SkuConfig, SkuType } from '../basket/entities/sku-config.entity';
import { CreateSweaterHeaderTemplateDto, CreateSweaterTransformDto, QuerySweaterTemplatesDto, QuerySweaterTransformJobsDto, SweaterTemplateColumnDto, UpdateSweaterHeaderTemplateDto } from './dto/sweater.dto';
import { SweaterHeaderTemplate } from './entities/sweater-header-template.entity';
import { SweaterTransformJob } from './entities/sweater-transform-job.entity';

const SWEATER_OUTPUT_DIR = path.join(process.cwd(), 'uploads', 'sweater');

function normalizeUploadsPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.startsWith('/uploads/')) return normalized;
  if (normalized.startsWith('uploads/')) return `/${normalized}`;
  const uploadsIndex = normalized.indexOf('uploads/');
  if (uploadsIndex >= 0) return `/${normalized.slice(uploadsIndex)}`;
  return normalized;
}

@Injectable()
export class SweaterService {
  private readonly logger = new Logger(SweaterService.name);

  constructor(
    @InjectRepository(SweaterHeaderTemplate)
    private readonly templateRepository: Repository<SweaterHeaderTemplate>,
    @InjectRepository(SweaterTransformJob)
    private readonly jobRepository: Repository<SweaterTransformJob>,
    @InjectRepository(ColorGroup)
    private readonly colorGroupRepository: Repository<ColorGroup>,
    @InjectRepository(ColorKv)
    private readonly colorKvRepository: Repository<ColorKv>,
    @InjectRepository(SkuConfig)
    private readonly skuConfigRepository: Repository<SkuConfig>,
    private readonly aliyunService: AliyunService,
    private readonly jobQueueService: JobQueueService,
  ) {
    if (!fs.existsSync(SWEATER_OUTPUT_DIR)) {
      fs.mkdirSync(SWEATER_OUTPUT_DIR, { recursive: true });
    }
  }

  async listTemplates(user: User, query: QuerySweaterTemplatesDto): Promise<PaginatedResponse<SweaterHeaderTemplate>> {
    const page = query.page && query.page > 0 ? Number(query.page) : 1;
    const limit = query.limit && query.limit > 0 ? Number(query.limit) : 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.templateRepository.createQueryBuilder('template')
      .where('template.is_active = :isActive', { isActive: true })
      .orderBy('template.updated_at', 'DESC')
      .skip(skip)
      .take(limit);

    if (!user.isAdmin) {
      queryBuilder.andWhere('template.user_id = :userId', { userId: user.id });
    }

    if (query.search?.trim()) {
      queryBuilder.andWhere('template.name ILIKE :search', { search: `%${query.search.trim()}%` });
    }

    const [items, total] = await queryBuilder.getManyAndCount();
    return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  async getTemplate(id: number, user: User): Promise<SweaterHeaderTemplate> {
    const template = await this.templateRepository.findOne({ where: { id } });
    if (!template || !template.isActive) throw new NotFoundException('模板不存在');
    if (!user.isAdmin && template.userId !== user.id) throw new ForbiddenException('无权访问该模板');
    return template;
  }

  async createTemplate(dto: CreateSweaterHeaderTemplateDto, user: User): Promise<SweaterHeaderTemplate> {
    await this.ensureTemplateNameUnique(dto.name, user.id);
    const normalizedColumns = this.normalizeColumns(dto.columns);
    await this.validateColumns(normalizedColumns);
    const normalizedColorGroupIds = await this.validateTemplateColorGroups(dto.colorGroupIds || [], user);

    const template = this.templateRepository.create({
      userId: user.id,
      name: dto.name.trim(),
      headerConfigJson: {
        colorGroupIds: normalizedColorGroupIds,
        columns: normalizedColumns,
      },
      mappingConfigJson: dto.mappingConfigJson || null,
      isActive: true,
    });

    return this.templateRepository.save(template);
  }

  async updateTemplate(id: number, dto: UpdateSweaterHeaderTemplateDto, user: User): Promise<SweaterHeaderTemplate> {
    const template = await this.getTemplate(id, user);

    if (dto.name !== undefined && dto.name.trim() !== template.name) {
      await this.ensureTemplateNameUnique(dto.name, user.id, id);
      template.name = dto.name.trim();
    }

    const currentColumns = template.headerConfigJson?.columns || [];
    const currentColorGroupIds = template.headerConfigJson?.colorGroupIds || [];

    if (dto.columns) {
      const normalizedColumns = this.normalizeColumns(dto.columns);
      await this.validateColumns(normalizedColumns);
      template.headerConfigJson = {
        colorGroupIds: currentColorGroupIds,
        columns: normalizedColumns,
      };
    }

    if (dto.colorGroupIds !== undefined) {
      const normalizedColorGroupIds = await this.validateTemplateColorGroups(dto.colorGroupIds || [], user);
      template.headerConfigJson = {
        colorGroupIds: normalizedColorGroupIds,
        columns: dto.columns ? template.headerConfigJson.columns : currentColumns,
      };
    }

    if (dto.mappingConfigJson !== undefined) {
      template.mappingConfigJson = dto.mappingConfigJson || null;
    }

    return this.templateRepository.save(template);
  }

  async removeTemplate(id: number, user: User): Promise<void> {
    const template = await this.getTemplate(id, user);
    template.isActive = false;
    await this.templateRepository.save(template);
  }

  async createTransformJob(file: Express.Multer.File, dto: CreateSweaterTransformDto, user: User) {
    const template = await this.getTemplate(dto.templateId, user);
    await this.ensureSweaterSkuConfigured(user);

    const jobId = this.jobQueueService.createJob(user.id);
    const entity = this.jobRepository.create({
      userId: user.id,
      templateId: template.id,
      jobId,
      inputFileName: file.originalname,
      inputFilePath: this.toUploadsWebPath(file.path),
      status: 'pending',
      progress: 0,
      totalRows: 0,
      outputRows: 0,
    });
    const saved = await this.jobRepository.save(entity);

    this.processTransformJob(saved.id, user.id).catch((error) => {
      this.logger.error(`Sweater transform job ${saved.jobId} failed: ${error.message}`, error.stack);
    });

    return {
      id: saved.id,
      jobId: saved.jobId,
      status: saved.status,
      progress: Number(saved.progress || 0),
      templateId: saved.templateId,
      inputFileName: saved.inputFileName,
      createdAt: saved.createdAt,
    };
  }

  async getTransformStatus(jobId: string, user: User) {
    const job = await this.jobRepository.findOne({ where: { jobId }, relations: ['template'] });
    if (!job) throw new NotFoundException('任务不存在');
    if (!user.isAdmin && job.userId !== user.id) throw new ForbiddenException('无权访问该任务');

    const progress = this.jobQueueService.getJobProgress(jobId);
    return {
      status: progress?.status || job.status,
      progress: Number(progress?.progress ?? job.progress ?? 0),
      message: progress?.message || job.errorMessage || '',
      result: job.outputFilePath ? {
        outputPath: job.outputFilePath,
        totalRows: job.totalRows,
        outputRows: job.outputRows,
      } : undefined,
      error: progress?.error || job.errorMessage || undefined,
      job,
    };
  }

  async listTransformJobs(query: QuerySweaterTransformJobsDto, user: User): Promise<PaginatedResponse<SweaterTransformJob>> {
    const page = query.page && query.page > 0 ? Number(query.page) : 1;
    const limit = query.limit && query.limit > 0 ? Number(query.limit) : 20;
    const skip = (page - 1) * limit;

    const queryBuilder = this.jobRepository.createQueryBuilder('job')
      .leftJoinAndSelect('job.template', 'template')
      .orderBy('job.createdAt', 'DESC')
      .skip(skip)
      .take(limit);

    if (!user.isAdmin) {
      queryBuilder.where('job.user_id = :userId', { userId: user.id });
    }

    if (query.search?.trim()) {
      queryBuilder.andWhere('(job.input_file_name ILIKE :search OR template.name ILIKE :search)', { search: `%${query.search.trim()}%` });
    }

    const [items, total] = await queryBuilder.getManyAndCount();
    return { items, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  private async processTransformJob(recordId: number, userId: string) {
    const job = await this.jobRepository.findOne({ where: { id: recordId }, relations: ['template'] });
    if (!job) return;

    job.status = 'processing';
    job.progress = 5;
    job.startedAt = new Date();
    await this.jobRepository.save(job);
    this.jobQueueService.updateJobProgress(job.jobId, { status: 'processing', progress: 5, message: '正在读取 Excel 文件' });

    try {
      const sourceRows = this.readSourceExcel(job.inputFilePath);
      const sweaterSkus = await this.getEnabledSweaterSkus(userId);
      const rows = sourceRows.filter((row) => sweaterSkus.has((row['SKU'] || '').trim()));
      if (!rows.length) {
        throw new BadRequestException('上传文件中未找到匹配已配置毛衣 SKU 的订单');
      }

      job.totalRows = rows.length;
      job.progress = 15;
      await this.jobRepository.save(job);
      this.jobQueueService.updateJobProgress(job.jobId, { status: 'processing', progress: 15, message: '正在准备模板与颜色字典' });

      const promptContext = await this.buildPromptContext(job.template, userId);
      const transformedRows = await this.transformRowsWithAI(rows, promptContext);

      job.progress = 75;
      await this.jobRepository.save(job);
      this.jobQueueService.updateJobProgress(job.jobId, { status: 'processing', progress: 75, message: '正在校验并写入目标 Excel' });

      const validatedRows = this.validateOutputRows(transformedRows, job.template.headerConfigJson?.columns || []);
      const outputFileName = `sweater-transform-${job.id}-${Date.now()}.xlsx`;
      const outputPhysicalPath = path.join(SWEATER_OUTPUT_DIR, outputFileName);
      const outputWebPath = `/uploads/sweater/${outputFileName}`;
      this.writeOutputExcel(validatedRows, job.template.headerConfigJson?.columns || [], outputPhysicalPath);

      job.status = 'completed';
      job.progress = 100;
      job.outputRows = validatedRows.length;
      job.outputFilePath = outputWebPath;
      job.finishedAt = new Date();
      job.errorMessage = null;
      await this.jobRepository.save(job);
      this.jobQueueService.updateJobProgress(job.jobId, {
        status: 'completed',
        progress: 100,
        message: '转换完成',
        result: { outputPath: outputWebPath, totalRows: job.totalRows, outputRows: job.outputRows },
      });
      this.jobQueueService.startJobCleanup(job.jobId);
    } catch (error) {
      job.status = 'failed';
      job.progress = 100;
      job.errorMessage = error instanceof Error ? error.message : '转换失败';
      job.finishedAt = new Date();
      await this.jobRepository.save(job);
      this.jobQueueService.updateJobProgress(job.jobId, {
        status: 'failed',
        progress: 100,
        message: job.errorMessage,
        error: job.errorMessage,
      });
      this.jobQueueService.startJobCleanup(job.jobId);
      throw error;
    }
  }

  private readSourceExcel(filePath: string): Record<string, string>[] {
    const workbook = XLSX.readFile(this.toPhysicalFilePath(filePath), { cellDates: false });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new BadRequestException('Excel 中未找到工作表');
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, any>>(sheet, { defval: '' });
    return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [String(key).trim(), value == null ? '' : String(value)])));
  }

  private async buildPromptContext(template: SweaterHeaderTemplate, userId: string) {
    const columns = [...(template.headerConfigJson?.columns || [])]
      .filter((column) => column.enabled)
      .sort((a, b) => a.order - b.order);
    const colorGroupIds = Array.from(new Set((template.headerConfigJson?.colorGroupIds || []).filter(Boolean)));

    const colorGroups = colorGroupIds.length
      ? await this.colorGroupRepository.createQueryBuilder('group')
          .where('group.id IN (:...groupIds)', { groupIds: colorGroupIds })
          .andWhere('group.userId = :userId', { userId })
          .getMany()
      : [];

    const colorEntries = colorGroupIds.length
      ? await this.colorKvRepository.createQueryBuilder('kv')
          .where('kv.groupId IN (:...groupIds)', { groupIds: colorGroupIds })
          .andWhere('kv.isActive = :isActive', { isActive: true })
          .getMany()
      : [];

    const colorGroupsById = new Map<number, { groupName?: string; options: Array<{ source: string; target: string }> }>();
    for (const entry of colorEntries) {
      if (!entry.groupId) continue;
      const groupId = Number(entry.groupId);
      const current = colorGroupsById.get(groupId) || {
        groupName: colorGroups.find((item) => Number(item.id) === groupId)?.name,
        options: [],
      };
      current.options.push({ source: entry.name, target: entry.colorValue });
      colorGroupsById.set(groupId, current);
    }

    return {
      templateName: template.name,
      colorGroupIds,
      columns,
      mappingConfigJson: template.mappingConfigJson || {},
      colorGroups: Object.fromEntries(Array.from(colorGroupsById.entries()).map(([id, value]) => [String(id), value])),
    };
  }

  private async transformRowsWithAI(rows: Record<string, string>[], promptContext: any): Promise<Record<string, string>[]> {
    const enabledKeys = (promptContext.columns || []).map((column: any) => column.key);
    const systemPrompt = `
你是 Etsy 毛衣订单 Excel 转换助手。
你的任务是把店铺后台订单行数据转换成工厂 Excel 行数据。

必须遵守：
1. 仅输出 JSON 对象，不要输出额外文本。
2. 输出格式必须是：
{
  "rows": [
    {"字段key1":"值1","字段key2":"值2"}
  ]
}
3. 只允许输出模板 columns 中 enabled=true 的 key，允许的 key 为：${JSON.stringify(enabledKeys)}。
4. 每个字段必须参考 columns 中的 label 和 description 来理解含义。
5. 颜色组信息位于模板级 colorGroups 中，若模板绑定了颜色组，请优先使用颜色组选项中的 target 值输出颜色相关字段。
6. 不要凭空编造订单；输入一行通常输出一行，除非源数据本身明确需要拆分。
7. 若无法判断字段，请保留尽可能准确的原始值，不要输出 null。
`;

    const userPrompt = JSON.stringify({ template: promptContext, sourceRows: rows }, null, 2);
    const result = await this.aliyunService.generateJson(userPrompt, { systemPrompt, maxTokens: 4000 });
    if (!result || !Array.isArray(result.rows)) {
      throw new BadRequestException('AI 返回格式不正确，缺少 rows 数组');
    }
    return result.rows.map((row) => Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key, value == null ? '' : String(value)])));
  }

  private validateOutputRows(rows: Record<string, string>[], columns: SweaterTemplateColumnDto[]): Record<string, string>[] {
    const enabledColumns = [...columns].filter((column) => column.enabled).sort((a, b) => a.order - b.order);
    return rows.map((row, index) => {
      const normalized: Record<string, string> = {};
      for (const column of enabledColumns) {
        normalized[column.key] = row[column.key] == null ? '' : String(row[column.key]).trim();
      }
      if (Object.keys(normalized).length === 0) {
        throw new BadRequestException(`第 ${index + 1} 行 AI 输出为空`);
      }
      return normalized;
    });
  }

  private writeOutputExcel(rows: Record<string, string>[], columns: SweaterTemplateColumnDto[], outputPath: string) {
    const enabledColumns = [...columns].filter((column) => column.enabled).sort((a, b) => a.order - b.order);
    const aoa = [enabledColumns.map((column) => column.label)];
    for (const row of rows) {
      aoa.push(enabledColumns.map((column) => row[column.key] || ''));
    }
    const worksheet = XLSX.utils.aoa_to_sheet(aoa);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    XLSX.writeFile(workbook, outputPath);
  }

  private async validateColumns(columns: SweaterTemplateColumnDto[]) {
    const keySet = new Set<string>();
    const orderSet = new Set<number>();

    for (const column of columns) {
      if (keySet.has(column.key)) {
        throw new BadRequestException(`字段 key 重复: ${column.key}`);
      }
      if (orderSet.has(column.order)) {
        throw new BadRequestException(`字段顺序重复: ${column.order}`);
      }
      keySet.add(column.key);
      orderSet.add(column.order);
    }
  }

  private normalizeColumns(columns: SweaterTemplateColumnDto[]) {
    return [...columns]
      .map((column) => ({
        ...column,
        key: column.key.trim(),
        label: column.label.trim(),
        description: column.description.trim(),
      }))
      .sort((a, b) => a.order - b.order);
  }

  private async validateTemplateColorGroups(colorGroupIds: number[], user: User): Promise<number[]> {
    const uniqueIds = Array.from(new Set((colorGroupIds || []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)));
    for (const id of uniqueIds) {
      const group = await this.colorGroupRepository.findOne({ where: { id } });
      if (!group || (!user.isAdmin && group.userId !== user.id)) {
        throw new BadRequestException(`颜色组不存在或无权限访问: ${id}`);
      }
    }
    return uniqueIds;
  }

  private async ensureTemplateNameUnique(name: string, userId: string, excludeId?: number) {
    const queryBuilder = this.templateRepository.createQueryBuilder('template')
      .where('template.user_id = :userId', { userId })
      .andWhere('template.name = :name', { name: name.trim() })
      .andWhere('template.is_active = true');

    if (excludeId) {
      queryBuilder.andWhere('template.id != :excludeId', { excludeId });
    }

    const existing = await queryBuilder.getOne();
    if (existing) throw new BadRequestException('模板名称已存在');
  }

  private async ensureSweaterSkuConfigured(user: User) {
    const count = await this.skuConfigRepository.count({ where: { userId: user.id, type: SkuType.SWEATER as any } });
    if (!count) {
      throw new BadRequestException('请先在 SKU 配置中创建至少一个毛衣 SKU');
    }
  }

  private async getEnabledSweaterSkus(userId: string): Promise<Set<string>> {
    const configs = await this.skuConfigRepository.find({ where: { userId, type: SkuType.SWEATER as any } });
    return new Set(configs.map((item) => item.sku?.trim()).filter(Boolean));
  }

  private toUploadsWebPath(filePath: string): string {
    return normalizeUploadsPath(filePath);
  }

  private toPhysicalFilePath(filePath: string): string {
    const normalized = normalizeUploadsPath(filePath);
    if (normalized.startsWith('/uploads/')) {
      return path.join(process.cwd(), normalized.slice(1));
    }
    return path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  }
}
