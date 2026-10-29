import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Query,
  Body,
  UseInterceptors,
  UploadedFile,
  UseGuards,
  Put,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { RattleService } from './rattle.service';
import { RattleExportSettings, RattleReviewService } from './rattle-review.service';
import { QueryOrderUploadJobsDto } from '../orders/dto/query-order-upload-jobs.dto';
import { QueryOrderUploadJobItemsDto } from '../orders/dto/query-order-upload-job-items.dto';

@ApiTags('摇铃订单管理')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('rattle')
export class RattleController {
  constructor(
    private readonly rattleService: RattleService,
    private readonly rattleReviewService: RattleReviewService,
  ) {}

  @Get('orders/:orderId/cleanup-candidates')
  @ApiOperation({ summary: '（R4）订单可清理的输出图：被替换的历史候选图、空白图' })
  async cleanupCandidates(@Param('orderId') orderId: string, @CurrentUser() user: User) {
    return this.rattleReviewService.getCleanupCandidates(orderId, user);
  }

  @Post('cleanup/preview')
  @ApiOperation({ summary: '（R4）批量预览可清理的输出图' })
  async cleanupPreview(@Body() body: { orderIds: string[] }, @CurrentUser() user: User) {
    return this.rattleReviewService.previewCleanup(body?.orderIds || [], user);
  }

  @Post('orders/:orderId/cleanup')
  @ApiOperation({ summary: '（R4）清理勾选的输出图，文件移到回收目录，可恢复' })
  async cleanup(@Param('orderId') orderId: string, @Body() body: { recordIds: number[] }, @CurrentUser() user: User) {
    return this.rattleReviewService.cleanup(orderId, body?.recordIds || [], user);
  }

  @Post('orders/:orderId/cleanup/restore')
  @ApiOperation({ summary: '（R4）从回收目录恢复已清理的输出图' })
  async restore(@Param('orderId') orderId: string, @Body() body: { recordIds: number[] }, @CurrentUser() user: User) {
    return this.rattleReviewService.restore(orderId, body?.recordIds || [], user);
  }

  @Get('export-settings')
  @ApiOperation({ summary: '（R5）十列导出的字段来源设置' })
  async getExportSettings() {
    return this.rattleReviewService.getExportSettings();
  }

  @Put('export-settings')
  @ApiOperation({ summary: '（R5）修改十列导出的字段来源设置（管理员）' })
  async updateExportSettings(@Body() body: Partial<RattleExportSettings>, @CurrentUser() user: User) {
    return this.rattleReviewService.updateExportSettings(body || {}, user);
  }

  @Post('export-ten-columns')
  @ApiOperation({ summary: '（R5）已审核摇铃订单按固定十列导出' })
  async exportTenColumns(@Body() body: { orderIds?: string[]; startDate?: string; endDate?: string }, @CurrentUser() user: User) {
    const result = await this.rattleReviewService.exportTenColumns(body || {}, user);
    return { ...result, filePath: `/${result.filePath}` };
  }

  @Post('upload')
  @ApiOperation({ summary: '上传摇铃订单Excel文件' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  async uploadRattleOrders(
    @UploadedFile() file: Express.Multer.File,
    @Body('originalFilename') originalFilename: string,
    @CurrentUser() user: User,
  ) {
    // 如果前端提供了 originalFilename，使用它来替代可能有编码问题的 file.originalname
    if (originalFilename) {
      file.originalname = originalFilename;
    }
    return this.rattleService.uploadRattleOrders(file, user);
  }

  @Get('upload/:jobId/status')
  @ApiOperation({ summary: '查询摇铃订单上传任务状态' })
  async getUploadJobStatus(
    @Param('jobId') jobId: string,
    @CurrentUser() user: User,
  ) {
    return this.rattleService.getUploadJobStatus(jobId, user);
  }

  @Post('upload/:jobId/cancel')
  @ApiOperation({ summary: '取消摇铃订单上传任务' })
  async cancelUploadJob(
    @Param('jobId') jobId: string,
    @CurrentUser() user: User,
  ) {
    return this.rattleService.cancelUploadJob(jobId, user);
  }

  @Get('upload-jobs')
  @ApiOperation({ summary: '获取摇铃上传任务历史列表' })
  async getUploadJobs(
    @Query() query: QueryOrderUploadJobsDto,
    @CurrentUser() user: User,
  ) {
    return this.rattleService.getUploadJobs(query, user);
  }

  @Get('upload-jobs/:jobId/items')
  @ApiOperation({ summary: '获取摇铃上传任务详情' })
  async getUploadJobItems(
    @Param('jobId') jobId: string,
    @Query() query: QueryOrderUploadJobItemsDto,
    @CurrentUser() user: User,
  ) {
    return this.rattleService.getUploadJobItems(jobId, query, user);
  }

  @Get('records')
  @ApiOperation({ summary: '获取摇铃订单生成记录列表' })
  async getRecords(
    @Query() query: any,
    @CurrentUser() user: User,
  ) {
    return this.rattleService.getRecords(query, user);
  }

  @Get('records/:id')
  @ApiOperation({ summary: '获取单个摇铃订单生成记录' })
  async getRecordById(
    @Param('id') id: number,
    @CurrentUser() user: User,
  ) {
    return this.rattleService.getRecordById(id, user);
  }

  @Delete('records')
  @ApiOperation({ summary: '批量删除摇铃订单记录' })
  async deleteManyRecords(
    @Body() body: { ids: number[] },
    @CurrentUser() user: User,
  ) {
    return this.rattleService.deleteManyRecords(body.ids, user);
  }
}