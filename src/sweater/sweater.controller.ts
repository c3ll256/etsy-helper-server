import { BadRequestException, Body, Controller, Get, Param, ParseIntPipe, Post, Put, Delete, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import * as path from 'path';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '../users/entities/user.entity';
import { SweaterService } from './sweater.service';
import { CreateSweaterHeaderTemplateDto, CreateSweaterTransformDto, QuerySweaterTemplatesDto, QuerySweaterTransformJobsDto, UpdateSweaterHeaderTemplateDto } from './dto/sweater.dto';

function decodeOriginalFilename(filename: string): string {
  try {
    return Buffer.from(filename, 'latin1').toString('utf8');
  } catch {
    return filename;
  }
}

@ApiTags('sweater')
@Controller('sweater')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class SweaterController {
  constructor(private readonly sweaterService: SweaterService) {}

  @Get('header-templates')
  @ApiOperation({ summary: '获取毛衣表头模板列表' })
  listTemplates(@Query() query: QuerySweaterTemplatesDto, @CurrentUser() user: User) {
    return this.sweaterService.listTemplates(user, query);
  }

  @Get('header-templates/:id')
  @ApiOperation({ summary: '获取毛衣表头模板详情' })
  getTemplate(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.sweaterService.getTemplate(id, user);
  }

  @Post('header-templates')
  @ApiOperation({ summary: '创建毛衣表头模板' })
  createTemplate(@Body() dto: CreateSweaterHeaderTemplateDto, @CurrentUser() user: User) {
    return this.sweaterService.createTemplate(dto, user);
  }

  @Put('header-templates/:id')
  @ApiOperation({ summary: '更新毛衣表头模板' })
  updateTemplate(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateSweaterHeaderTemplateDto, @CurrentUser() user: User) {
    return this.sweaterService.updateTemplate(id, dto, user);
  }

  @Delete('header-templates/:id')
  @ApiOperation({ summary: '删除毛衣表头模板' })
  removeTemplate(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    return this.sweaterService.removeTemplate(id, user);
  }

  @Post('transform')
  @ApiOperation({ summary: '创建毛衣 Excel 转换任务' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file'))
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'templateId'],
      properties: {
        file: { type: 'string', format: 'binary' },
        templateId: { type: 'number' },
      },
    },
  })
  async transform(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: CreateSweaterTransformDto,
    @CurrentUser() user: User,
  ) {
    if (!file) throw new BadRequestException('没有提供 Excel 文件');
    const decodedOriginalName = decodeOriginalFilename(file.originalname);
    const ext = path.extname(decodedOriginalName).toLowerCase();
    if (!ext.match(/^\.(xlsx|xls)$/)) throw new BadRequestException('请上传 Excel 文件');
    file.originalname = decodedOriginalName;
    return this.sweaterService.createTransformJob(file, dto, user);
  }

  @Get('transform/:jobId/status')
  @ApiOperation({ summary: '获取毛衣转换任务状态' })
  getStatus(@Param('jobId') jobId: string, @CurrentUser() user: User) {
    return this.sweaterService.getTransformStatus(jobId, user);
  }

  @Get('transform-jobs')
  @ApiOperation({ summary: '获取毛衣转换任务列表' })
  listJobs(@Query() query: QuerySweaterTransformJobsDto, @CurrentUser() user: User) {
    return this.sweaterService.listTransformJobs(query, user);
  }
}
