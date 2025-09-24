import { 
  Controller, 
  Get, 
  Post, 
  Body, 
  Param, 
  Delete, 
  Res,
  HttpStatus,
  ParseIntPipe,
  BadRequestException,
  Put,
  Req,
  UseGuards,
  Query,
  NotFoundException,
  ForbiddenException
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { Response, Request } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as multer from 'multer';
import { promisify } from 'util';

import { StampsService } from './stamps.service';
import { PythonStampService } from './services/python-stamp.service';
import { CreateStampTemplateDto } from './dto/create-stamp-template.dto';
import { PreviewStampDto } from './dto/preview-stamp.dto';
import { CloneStampTemplateDto } from './dto/clone-stamp-template.dto';
import { UpdateStampTemplateDto } from './dto/update-stamp-template.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { PaginationDto } from '../common/dto/pagination.dto';
import { StampType } from './entities/stamp-template.entity';
import { PaginatedResponse } from '../common/interfaces/pagination.interface';
import { StampTemplate } from './entities/stamp-template.entity';
import { JobQueueService } from '../common/services/job-queue.service';

const UPLOAD_DIR = 'uploads/backgrounds';

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

@ApiTags('stamps')
@Controller('stamps')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class StampsController {
  constructor(
    private readonly stampsService: StampsService,
    private readonly pythonStampService: PythonStampService,
    private readonly jobQueueService: JobQueueService,
  ) {}

  @Post('templates')
  @ApiOperation({ summary: 'Create a new stamp template' })
  @ApiResponse({ status: 201, description: 'The stamp template has been successfully created' })
  @ApiResponse({ status: 400, description: 'Invalid input or SKU already exists' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async create(
    @Body() createStampTemplateDto: CreateStampTemplateDto, 
    @CurrentUser() user: User
  ) {
    return this.stampsService.create(createStampTemplateDto, user);
  }

  @Get('templates')
  @ApiOperation({ summary: 'Get all stamp templates (paginated)' })
  @ApiResponse({ status: 200, description: 'Return a paginated list of stamp templates' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Page number' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items per page' })
  @ApiQuery({ name: 'search', required: false, type: String, description: 'Search by name or SKU' })
  @ApiQuery({ name: 'type', required: false, enum: StampType, description: 'Filter by stamp type' })
  async findAll(
    @Query() paginationDto: PaginationDto, 
    @CurrentUser() user: User,
    @Query('search') search?: string,
    @Query('type') type?: StampType
  ): Promise<PaginatedResponse<StampTemplate>> {
    return this.stampsService.findAll(paginationDto, user, search, type);
  }

  @Post('upload-background')
  @ApiOperation({ summary: '上传印章背景图片' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: '印章背景图片文件',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: '背景图片上传成功' })
  @ApiResponse({ status: 400, description: '无效的文件类型或大小' })
  async uploadBackground(@Req() req: Request, @Res() res: Response) {
    // 确保上传目录存在
    const uploadDir = path.join(process.cwd(), 'uploads', 'backgrounds');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    
    // 创建 multer 实例，手动处理文件上传
    const storage = multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) => {
        // 生成唯一文件名
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const extension = path.extname(file.originalname);
        cb(null, uniqueSuffix + extension);
      }
    });
    
    const upload = multer({
      storage: storage,
      limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
      },
      fileFilter: (req, file, cb) => {
        const allowedMimes = ['image/png', 'image/jpeg', 'image/jpg'];
        const allowedExts = ['.png', '.jpg', '.jpeg'];
        
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedMimes.includes(file.mimetype) && allowedExts.includes(ext)) {
          cb(null, true);
        } else {
          // 拒绝文件但不抛出错误
          cb(null, false);
          // 在 req 对象中存储错误信息，稍后处理
          req['fileValidationError'] = '仅支持 PNG 或 JPG 格式的图片';
        }
      }
    }).single('file');
    
    // 将回调形式的 upload 转换为 Promise
    const uploadPromisified = promisify(upload);
    
    try {
      // 执行上传
      await uploadPromisified(req, res);
      
      // 检查自定义验证错误
      if (req['fileValidationError']) {
        return res.status(400).json({ 
          success: false, 
          message: req['fileValidationError'] 
        });
      }
      
      if (!req.file) {
        return res.status(400).json({ message: '未提供文件或文件上传失败' });
      }
      
      // 返回文件信息
      return res.status(201).json({
        success: true,
        filePath: `uploads/backgrounds/${req.file.filename}`,
        fileName: req.file.originalname,
      });
    } catch (error) {
      let message = '文件上传失败';
      if (error instanceof Error) {
        message = error.message;
      }
      console.error("Upload background error:", error);
      return res.status(400).json({ 
        success: false, 
        message: message 
      });
    }
  }

  @Get('templates/:id')
  @ApiOperation({ summary: 'Get a stamp template by id' })
  @ApiResponse({ status: 200, description: 'Return the stamp template' })
  @ApiResponse({ status: 404, description: 'Stamp template not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User
  ) {
    return this.stampsService.findById(id, user);
  }

  @Delete('templates/:id')
  @ApiOperation({ summary: 'Delete a stamp template' })
  @ApiResponse({ status: 200, description: 'The stamp template has been successfully deleted' })
  @ApiResponse({ status: 404, description: 'Stamp template not found' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async remove(
    @Param('id', ParseIntPipe) id: number, 
    @CurrentUser() user: User
  ) {
    await this.stampsService.remove(id, user);
    return { message: 'Template deleted successfully' };
  }

  @Post('preview')
  @ApiOperation({ summary: 'Preview a stamp with custom parameters' })
  @ApiResponse({ status: 200, description: 'Returns the preview image of the stamp' })
  @ApiResponse({ status: 400, description: 'Bad request (e.g., invalid data)' })
  @ApiBody({ type: PreviewStampDto })
  async previewStamp(@Body() previewStampDto: PreviewStampDto, @Res() res: Response) {
    let template: any = null;
    
    if (previewStampDto.templateId) {
      try {
        template = await this.stampsService.findById(previewStampDto.templateId, null);
      } catch (error) {
        template = {
          id: 0,
          name: 'Preview',
          sku: 'preview-sku',
          userId: 0,
          type: StampType.RUBBER,
          width: previewStampDto.width || 500,
          height: previewStampDto.height || 500,
          backgroundImagePath: previewStampDto.backgroundImagePath,
          textElements: []
        };
      }
    } else {
      template = {
        id: 0,
        name: 'Preview',
        sku: 'preview-sku',
        userId: 0,
        type: StampType.RUBBER,
        width: previewStampDto.width || 500,
        height: previewStampDto.height || 500,
        backgroundImagePath: previewStampDto.backgroundImagePath,
        textElements: []
      };
    }

    try {
      const buffer = await this.pythonStampService.generateStamp({
        template,
        textElements: previewStampDto.textElements,
        convertTextToPaths: previewStampDto.convertTextToPaths || false
      });

      const contentType = 'image/png';
      res.set({
        'Content-Type': contentType,
        'Content-Length': buffer.length,
      });
      return res.status(HttpStatus.OK).send(buffer);
    } catch (error) {
      console.error("Preview generation error:", error);
      let message = 'Failed to generate preview.';
      if (error instanceof Error) {
        message = error.message;
      }
      throw new BadRequestException(message);
    }
  }

  @Post('templates/clone')
  @ApiOperation({ summary: '克隆现有印章模板' })
  @ApiResponse({ status: 201, description: '印章模板克隆成功' })
  @ApiResponse({ status: 404, description: '源模板不存在' })
  @ApiResponse({ status: 400, description: 'SKU已存在或数据无效' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async cloneTemplate(
    @Body() cloneStampTemplateDto: CloneStampTemplateDto, 
    @CurrentUser() user: User
  ) {
    return this.stampsService.cloneTemplate(cloneStampTemplateDto, user);
  }

  @Put('templates/:id')
  @ApiOperation({ summary: 'Update a stamp template' })
  @ApiResponse({ status: 200, description: 'The stamp template has been successfully updated' })
  @ApiResponse({ status: 404, description: 'Stamp template not found' })
  @ApiResponse({ status: 400, description: 'Invalid data or SKU already exists' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateStampTemplateDto: UpdateStampTemplateDto,
    @CurrentUser() user: User,
    @Query('regenerateOrders') regenerateOrders?: boolean
  ) {
    const updatedTemplate = await this.stampsService.update(id, updateStampTemplateDto, user);

    // 如果指定了需要重新生成订单，创建一个异步任务
    if (regenerateOrders) {
      const jobId = this.jobQueueService.createJob(user.id as string);
      
      // 启动异步处理
      this.stampsService.regenerateOrderStamps(id, updatedTemplate, jobId).catch(error => {
        console.error('Failed to regenerate stamps:', error);
        this.jobQueueService.updateJobProgress(jobId, {
          status: 'failed',
          message: `Failed to regenerate stamps: ${error.message}`,
          error: error.message
        });
      });

      return {
        template: updatedTemplate,
        regenerationJob: {
          jobId,
          status: 'pending',
          message: 'Stamp regeneration started'
        }
      };
    }
    
    return updatedTemplate;
  }

  @Get('regeneration/:jobId')
  @ApiOperation({ summary: 'Get stamp regeneration job status' })
  @ApiResponse({ status: 200, description: 'Return the job status' })
  @ApiResponse({ status: 404, description: 'Job not found' })
  async getRegenerationStatus(
    @Param('jobId') jobId: string,
    @CurrentUser() user: User
  ) {
    const jobProgress = this.jobQueueService.getJobProgress(jobId);
    if (!jobProgress) {
      throw new NotFoundException('Regeneration job not found');
    }

    // 验证作业所有权
    if (!user.isAdmin && jobProgress.userId !== user.id) {
      throw new ForbiddenException('You do not have permission to access this job');
    }

    return jobProgress;
  }
} 