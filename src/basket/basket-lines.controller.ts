import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, Res, UploadedFile, UseGuards, UseInterceptors, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { BasketLinesService, LineQuery } from './basket-lines.service';

const REFERENCE_DIR = 'uploads/baskets/reference';
if (!fs.existsSync(REFERENCE_DIR)) fs.mkdirSync(REFERENCE_DIR, { recursive: true });

function toQuery(q: any): LineQuery {
  const bool = (v: any) => v === true || v === 'true' || v === '1';
  return {
    page: q.page ? Number(q.page) : undefined,
    limit: q.limit ? Number(q.limit) : undefined,
    recordId: q.recordId ? Number(q.recordId) : undefined,
    orderId: q.orderId || undefined,
    sku: q.sku || undefined,
    status: q.status || undefined,
    category: q.category || undefined,
    search: q.search || undefined,
    onlyExceptions: bool(q.onlyExceptions),
    includeResolved: bool(q.includeResolved),
    orderNoPages: bool(q.orderNoPages),
    startDate: q.startDate || undefined,
    endDate: q.endDate || undefined,
  };
}

function parseIds(body: any): number[] {
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!ids.length) throw new BadRequestException('请提供 ids');
  if (ids.length > 2000) throw new BadRequestException('一次最多 2000 条');
  return ids;
}

@ApiTags('baskets')
@Controller('baskets')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class BasketLinesController {
  constructor(private readonly service: BasketLinesService) {}

  // ---------------- 明细 / 审核
  @Get('lines')
  @ApiOperation({ summary: '母婴订单明细列表（每行 Excel 一条，含解析结果、匹配状态、实际生成结果）' })
  listLines(@Query() query: any, @CurrentUser() user: User) {
    return this.service.listLines(user, toQuery(query));
  }

  @Get('lines/:id')
  @ApiOperation({ summary: '明细详情（含同订单的其他明细、NOTE 原文、参考图）' })
  getLine(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.service.getLine(id, user);
  }

  @Put('lines/:id/manual')
  @ApiOperation({ summary: '人工指定这一行每件商品的名字 / 图标（只影响本行），保存后立即重新解析' })
  setManual(@Param('id', ParseIntPipe) id: number, @Body() body: any, @CurrentUser() user: User) {
    return this.service.setManualOverride(id, user, body?.override ?? null);
  }

  @Put('lines/:id/resolution')
  @ApiOperation({ summary: '标记异常已线下处理（ignored）或撤销' })
  resolve(@Param('id', ParseIntPipe) id: number, @Body() body: any, @CurrentUser() user: User) {
    return this.service.resolveLine(id, user, body?.resolution ?? null, body?.note);
  }

  @Post('lines/reprocess')
  @ApiOperation({ summary: '批量重新匹配 SKU 并解析（不生成 PPT），用于修改配置后检查结果' })
  reprocess(@Body() body: any, @CurrentUser() user: User) {
    return this.service.reprocessLines(parseIds(body), user);
  }

  @Post('lines/regenerate')
  @ApiOperation({ summary: '补处理：把所选明细所在订单的全部明细放进一条新的生成记录，重新生成 PPT' })
  regenerateLines(@Body() body: any, @CurrentUser() user: User) {
    return this.service.regenerateForLines(parseIds(body), user);
  }

  // ---------------- 异常清单
  @Get('exceptions')
  @ApiOperation({ summary: '异常清单（未匹配、冲突、待核对、系统异常、整单无页），可筛选' })
  exceptions(@Query() query: any, @CurrentUser() user: User) {
    return this.service.listLines(user, { ...toQuery(query), onlyExceptions: true });
  }

  @Get('exceptions/summary')
  @ApiOperation({ summary: '异常清单按类别汇总' })
  exceptionSummary(@Query() query: any, @CurrentUser() user: User) {
    return this.service.exceptionSummary(user, toQuery(query));
  }

  @Get('exceptions/export')
  @ApiOperation({ summary: '导出异常清单 Excel' })
  async exportExceptions(@Query() query: any, @CurrentUser() user: User, @Res() res: Response) {
    const buffer = await this.service.exportExceptions(user, toQuery(query));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="basket-exceptions-${Date.now()}.xlsx"`);
    res.send(buffer);
  }

  // ---------------- 记录级重处理
  @Post('records/:id/regenerate')
  @ApiOperation({ summary: '按保存的明细重新生成整条记录（不需要重新上传；旧文件保留为备份）' })
  regenerateRecord(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.service.regenerateRecord(id, user);
  }

  @Post('records/:id/backfill-lines')
  @ApiOperation({ summary: '历史记录补建明细（原始上传文件仍在服务器上时）' })
  backfill(@Param('id', ParseIntPipe) id: number, @Body() body: any, @CurrentUser() user: User) {
    return this.service.backfillRecordLines(id, user, body?.sourceFilePath);
  }

  // ---------------- 图标布局模板
  @Get('layout-templates')
  @ApiOperation({ summary: '图标布局模板列表（含使用该模板的 SKU）' })
  listTemplates(@CurrentUser() user: User) {
    return this.service.listTemplates(user);
  }

  @Post('layout-templates')
  @ApiOperation({ summary: '新建图标布局模板' })
  createTemplate(@Body() body: any, @CurrentUser() user: User) {
    return this.service.saveTemplate(user, body);
  }

  @Put('layout-templates/:id')
  @ApiOperation({ summary: '修改图标布局模板' })
  updateTemplate(@Param('id', ParseIntPipe) id: number, @Body() body: any, @CurrentUser() user: User) {
    return this.service.saveTemplate(user, body, id);
  }

  @Delete('layout-templates/:id')
  @ApiOperation({ summary: '停用图标布局模板（仍被 SKU 使用时不允许）' })
  deleteTemplate(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.service.deleteTemplate(user, id);
  }

  // ---------------- SKU 复制
  @Get('sku-config-copy-fields')
  @ApiOperation({ summary: '复制 SKU 时会复制的字段' })
  copyFields() {
    return BasketLinesService.COPY_FIELDS;
  }

  @Post('sku-config/:id/copy')
  @ApiOperation({ summary: '复制 SKU 配置为新 SKU（新 SKU 不能重名，原配置不受影响）' })
  copySku(@Param('id', ParseIntPipe) id: number, @Body() body: any, @CurrentUser() user: User) {
    return this.service.copySkuConfig(id, user, body?.sku, body?.overrides);
  }

  // ---------------- 参考图
  @Get('reference-images')
  @ApiOperation({ summary: 'SKU 母体参考图（skuConfigId 或 groupKey）' })
  listReferenceImages(@Query() query: any, @CurrentUser() user: User) {
    return this.service.listReferenceImages(user, { skuConfigId: query.skuConfigId ? Number(query.skuConfigId) : undefined, groupKey: query.groupKey });
  }

  @Post('reference-images')
  @ApiOperation({ summary: '上传 / 更换参考图（replaceId 表示更换）' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 10 * 1024 * 1024 },
    storage: diskStorage({
      destination: (_req, _file, cb) => cb(null, REFERENCE_DIR),
      filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
        cb(null, `ref-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
      },
    }),
  }))
  addReferenceImage(@UploadedFile() file: Express.Multer.File, @Body() body: any, @CurrentUser() user: User) {
    if (file) {
      try {
        file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
      } catch {}
    }
    return this.service.addReferenceImage(user, file, {
      skuConfigId: body.skuConfigId ? Number(body.skuConfigId) : undefined,
      groupKey: body.groupKey,
      caption: body.caption,
      replaceId: body.replaceId ? Number(body.replaceId) : undefined,
    });
  }

  @Delete('reference-images/:id')
  @ApiOperation({ summary: '移除参考图' })
  removeReferenceImage(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.service.removeReferenceImage(user, id);
  }

  // ---------------- 店铺开关
  @Get('shop-settings')
  @ApiOperation({ summary: '本店母婴生成开关（特殊字符标注等）' })
  getSettings(@CurrentUser() user: User) {
    return this.service.getShopSettings(user.id);
  }

  @Put('shop-settings')
  @ApiOperation({ summary: '修改本店母婴生成开关' })
  updateSettings(@Body() body: any, @CurrentUser() user: User) {
    return this.service.updateShopSettings(user.id, body || {});
  }

  // ---------------- 总 SKU（母体分组）
  @Get('parent-skus')
  @ApiOperation({ summary: '总 SKU 分组列表（含下属子 SKU 及共用参考图）' })
  listParentSkus(@Query('search') search: string | undefined, @CurrentUser() user: User) {
    return this.service.listParentSkus(user, search);
  }

  @Post('parent-skus')
  @ApiOperation({ summary: '新建或保存总 SKU 分组（可同时绑定子 SKU 并同步设置）' })
  upsertParentSku(@Body() body: any, @CurrentUser() user: User) {
    return this.service.upsertParentSku(user, body || {});
  }

  @Put('parent-skus/:id')
  @ApiOperation({ summary: '更新总 SKU 分组（可同时同步设置到下属子 SKU）' })
  updateParentSku(@Param('id', ParseIntPipe) id: number, @Body() body: any, @CurrentUser() user: User) {
    return this.service.updateParentSku(user, id, body || {});
  }

  @Post('parent-skus/:id/sync')
  @ApiOperation({ summary: '将总 SKU 的统一设置同步到全部子 SKU' })
  syncParentSku(@Param('id', ParseIntPipe) id: number, @Body() body: any, @CurrentUser() user: User) {
    return this.service.syncParentSkuToChildren(user, id, body?.fields);
  }

  @Delete('parent-skus/:id')
  @ApiOperation({ summary: '删除总 SKU 分组（不删除下属子 SKU）' })
  deleteParentSku(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.service.deleteParentSku(user, id);
  }
}
