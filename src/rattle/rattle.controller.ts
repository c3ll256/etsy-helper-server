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
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiConsumes, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { RattleService } from './rattle.service';
import { QueryOrderUploadJobsDto } from '../orders/dto/query-order-upload-jobs.dto';
import { QueryOrderUploadJobItemsDto } from '../orders/dto/query-order-upload-job-items.dto';

@ApiTags('摇铃订单管理')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('rattle')
export class RattleController {
  constructor(private readonly rattleService: RattleService) {}

  @Post('upload')
  @ApiOperation({ summary: '上传摇铃订单Excel文件' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  async uploadRattleOrders(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: User,
  ) {
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