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
  UseInterceptors,
  UploadedFile,
  BadRequestException,
  Put
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';

import { StampsService } from './stamps.service';
import { PythonStampService } from './services/python-stamp.service';
import { CreateStampTemplateDto } from './dto/create-stamp-template.dto';
import { GenerateStampDto } from './dto/generate-stamp.dto';
import { PreviewStampDto } from './dto/preview-stamp.dto';
import { CloneStampTemplateDto } from './dto/clone-stamp-template.dto';
import { UpdateStampTemplateDto } from './dto/update-stamp-template.dto';
import { GlmService } from 'src/common/services/glm.service';

const UPLOAD_DIR = 'uploads/backgrounds';

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

@ApiTags('stamps')
@Controller('stamps')
export class StampsController {
  constructor(
    private readonly stampsService: StampsService,
    private readonly pythonStampService: PythonStampService, 
    private readonly glmService: GlmService
  ) {}

  @Post('templates')
  @ApiOperation({ summary: 'Create a new stamp template' })
  @ApiResponse({ status: 201, description: 'The stamp template has been successfully created' })
  async create(@Body() createStampTemplateDto: CreateStampTemplateDto) {
    return this.stampsService.create(createStampTemplateDto);
  }

  @Get('templates')
  @ApiOperation({ summary: 'Get all stamp templates' })
  @ApiResponse({ status: 200, description: 'Return all stamp templates' })
  async findAll() {
    return this.stampsService.findAll();
  }

  @Get('templates/:id')
  @ApiOperation({ summary: 'Get a stamp template by id' })
  @ApiResponse({ status: 200, description: 'Return the stamp template' })
  @ApiResponse({ status: 404, description: 'Stamp template not found' })
  async findOne(@Param('id') id: string) {
    return this.stampsService.findById(+id);
  }

  @Delete('templates/:id')
  @ApiOperation({ summary: 'Delete a stamp template' })
  @ApiResponse({ status: 200, description: 'The stamp template has been successfully deleted' })
  @ApiResponse({ status: 404, description: 'Stamp template not found' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.stampsService.remove(id);
    return { message: 'Template deleted successfully' };
  }

  @Post('preview')
  @ApiOperation({ summary: 'Preview a stamp with custom parameters' })
  @ApiResponse({ status: 200, description: 'Returns the preview image of the stamp' })
  @ApiResponse({ status: 400, description: 'Bad request' })
  @ApiBody({ type: PreviewStampDto })
  async previewStamp(@Body() previewStampDto: PreviewStampDto, @Res() res: Response) {
    let template = null;
    
    // 如果提供了模板 ID，则获取模板
    if (previewStampDto.templateId) {
      try {
        template = await this.stampsService.findById(previewStampDto.templateId);
      } catch (error) {
        // 如果找不到模板，则使用提供的参数创建临时模板
        template = {
          id: 0,
          width: previewStampDto.width || 500,
          height: previewStampDto.height || 500,
          backgroundImagePath: previewStampDto.backgroundImagePath,
          textElements: []
        };
      }
    } else {
      // 创建临时模板
      template = {
        id: 0,
        width: previewStampDto.width || 500,
        height: previewStampDto.height || 500,
        backgroundImagePath: previewStampDto.backgroundImagePath,
        textElements: []
      };
    }
    
    // 使用 Python 服务生成预览
    const buffer = await this.pythonStampService.generateStamp({
      template,
      textElements: previewStampDto.textElements,
      convertTextToPaths: previewStampDto.convertTextToPaths || false
    });
    
    // 设置响应头
    const contentType = 'image/svg+xml'
    
    res.set({
      'Content-Type': contentType,
      'Content-Length': buffer.length,
    });
    
    return res.status(HttpStatus.OK).send(buffer);
  }

  @Post('upload-background')
  @UseInterceptors(
    FileInterceptor('file', {
      fileFilter: (req, file, callback) => {
        const allowedMimes = ['image/svg+xml'];
        const allowedExts = ['.svg'];
        
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedMimes.includes(file.mimetype) && allowedExts.includes(ext)) {
          callback(null, true);
        } else {
          callback(new BadRequestException('仅支持 SVG 格式的图片'), false);
        }
      },
      limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
      },
      dest: 'uploads/backgrounds',
    }),
  )
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
  async uploadBackground(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('未提供文件或文件上传失败');
    }

    // 确保目录存在
    const uploadsDir = path.join(process.cwd(), 'uploads', 'backgrounds');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // 返回文件相对路径
    const relativePath = path.join('uploads', 'backgrounds', file.filename);
    return {
      success: true,
      filePath: relativePath,
      fileName: file.originalname,
    };
  }

  @Post('templates/clone')
  @ApiOperation({ summary: '克隆现有印章模板' })
  @ApiResponse({ status: 201, description: '印章模板克隆成功' })
  @ApiResponse({ status: 404, description: '源模板不存在' })
  @ApiResponse({ status: 400, description: 'SKU已存在或数据无效' })
  async cloneTemplate(@Body() cloneStampTemplateDto: CloneStampTemplateDto) {
    return this.stampsService.cloneTemplate(cloneStampTemplateDto);
  }

  @Get('test')
  @ApiOperation({ summary: 'Test API' })
  @ApiResponse({ status: 200, description: 'Test successful' })
  test() {
    return this.glmService.generateText('你好');
  }

  @Put('templates/:id')
  @ApiOperation({ summary: 'Update a stamp template' })
  @ApiResponse({ status: 200, description: 'The stamp template has been successfully updated' })
  @ApiResponse({ status: 404, description: 'Stamp template not found' })
  @ApiResponse({ status: 400, description: 'Invalid data or SKU already exists' })
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body() updateStampTemplateDto: UpdateStampTemplateDto
  ) {
    return this.stampsService.update(id, updateStampTemplateDto);
  }
} 