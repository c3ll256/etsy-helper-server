import { 
  Controller, 
  Get, 
  Post, 
  Body, 
  Param, 
  Delete,
  UseInterceptors,
  UploadedFile,
  ParseIntPipe,
  BadRequestException,
  Patch,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody, ApiQuery, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import * as fs from 'fs';
import * as path from 'path';
import { diskStorage } from 'multer';

import { FontsService } from './fonts.service';
import { CreateFontDto } from './dto/create-font.dto';
import { validateFontFile } from '../common/utils/file-validator.util';

const UPLOADS_DIR = 'uploads/fonts';

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/**
 * 清理文件名，移除路径遍历和危险字符
 * SECURITY: 防止文件名注入攻击
 */
function sanitizeFilename(filename: string): string {
  // 只取文件名部分，移除路径
  let sanitized = path.basename(filename)
    .replace(/[\/\\]/g, '') // 移除路径分隔符
    .replace(/\.\./g, '') // 移除路径遍历
    .replace(/[<>:"|?*\x00-\x1F]/g, '') // 移除Windows禁止字符和控制字符
    .trim();
  
  // 限制文件名长度
  if (sanitized.length > 255) {
    const ext = path.extname(sanitized);
    sanitized = sanitized.slice(0, 255 - ext.length) + ext;
  }
  
  return sanitized || 'file';
}

/**
 * 清理文件扩展名，只保留安全的字符
 * SECURITY: 防止扩展名注入
 */
function sanitizeExtension(originalname: string): string {
  const ext = path.extname(originalname).toLowerCase();
  // 只允许字母和数字，移除其他字符
  const sanitizedExt = ext.replace(/[^a-z0-9]/g, '');
  // 限制扩展名长度
  return sanitizedExt.slice(0, 10);
}

@ApiTags('fonts')
@Controller('fonts')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class FontsController {
  constructor(private readonly fontsService: FontsService) {}

  @Post()
  @ApiOperation({ summary: 'Upload a new font' })
  @ApiResponse({ status: 201, description: 'The font has been successfully uploaded.' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'Font file (.ttf, .otf, .woff, or .woff2)',
        },
        name: {
          type: 'string',
          description: 'Name of the font',
        },
        fontWeight: {
          type: 'string',
          description: 'Font weight (e.g., regular, bold, 700)',
        },
        isVariableFont: {
          type: 'boolean',
          description: 'Whether this is a variable font',
        },
        description: {
          type: 'string',
          description: 'Description of the font',
        },
      },
      required: ['file', 'name'],
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: UPLOADS_DIR,
        filename: (req, file, cb) => {
          // SECURITY: 清理文件名和扩展名，防止路径遍历攻击
          const sanitizedExt = sanitizeExtension(file.originalname);
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
          const filename = `font-${uniqueSuffix}${sanitizedExt}`;
          cb(null, filename);
        },
      }),
      limits: {
        fileSize: 10 * 1024 * 1024, // SECURITY: 限制字体文件大小为10MB，防止DoS攻击
      },
      fileFilter: (req, file, cb) => {
        const validExt = ['.ttf', '.otf', '.woff', '.woff2'];
        const ext = path.extname(file.originalname).toLowerCase();
        if (validExt.includes(ext)) {
          cb(null, true);
        } else {
          cb(new BadRequestException('Invalid file type. Only .ttf, .otf, .woff, and .woff2 files are allowed.'), false);
        }
      },
    }),
  )
  async uploadFont(
    @UploadedFile() file: Express.Multer.File,
    @Body('name') name: string,
    @Body('fontWeight') fontWeight?: string,
    @Body('isVariableFont') isVariableFontStr?: string,
    @Body('description') description?: string,
  ) {
    if (!file) {
      throw new BadRequestException('Font file is required');
    }
    
    if (!name) {
      throw new BadRequestException('Font name is required');
    }
    
    // SECURITY: 验证文件的实际内容类型，只允许字体文件
    try {
      await validateFontFile(file.path);
    } catch (error) {
      // 删除已上传的文件
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      throw new BadRequestException(
        error.message || '文件类型验证失败，只允许上传字体文件'
      );
    }
    
    // 创建 DTO 对象
    const createFontDto = new CreateFontDto();
    createFontDto.name = name;
    createFontDto.fontWeight = fontWeight;
    createFontDto.isVariableFont = isVariableFontStr === 'true';
    createFontDto.description = description;
    
    return this.fontsService.create(createFontDto, file);
  }

  @Get()
  @ApiOperation({ summary: 'Get all fonts' })
  @ApiResponse({ status: 200, description: 'Return all fonts' })
  @ApiQuery({ name: 'active', required: false, type: Boolean, description: 'Filter by active status' })
  async findAll(@Query('active') active?: string) {
    // If active parameter is provided, filter by active status
    if (active !== undefined) {
      const isActive = active === 'true';
      return this.fontsService.findAllByStatus(isActive);
    }
    return this.fontsService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a font by ID' })
  @ApiResponse({ status: 200, description: 'Return the font' })
  @ApiResponse({ status: 404, description: 'Font not found' })
  async findOne(@Param('id', ParseIntPipe) id: number) {
    return this.fontsService.findOne(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a font' })
  @ApiResponse({ status: 200, description: 'The font has been successfully deleted' })
  @ApiResponse({ status: 404, description: 'Font not found' })
  @ApiResponse({ status: 400, description: 'Font is being used by templates and cannot be deleted' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.fontsService.remove(id);
    return { message: 'Font deleted successfully' };
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update font active status' })
  @ApiResponse({ status: 200, description: 'The font status has been successfully updated' })
  @ApiResponse({ status: 404, description: 'Font not found' })
  async updateStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body('isActive') isActive: boolean,
  ) {
    return this.fontsService.updateStatus(id, isActive);
  }

  @Get(':id/usage')
  @ApiOperation({ summary: 'Check if a font is being used by any templates' })
  @ApiResponse({ status: 200, description: 'Returns usage information' })
  @ApiResponse({ status: 404, description: 'Font not found' })
  async checkFontUsage(@Param('id', ParseIntPipe) id: number) {
    return this.fontsService.isFontUsedByTemplates(id);
  }

  @Get('editor')
  @ApiOperation({ summary: 'Get all active fonts for the stamp editor' })
  @ApiResponse({ status: 200, description: 'Return all active fonts with URLs' })
  async getEditorFonts() {
    const fonts = await this.fontsService.findAllByStatus(true);
    
    // For each font, create a URL that can be used in @font-face CSS
    return fonts.map(font => {
      // Extract the relative path from the filePath
      const relativePath = font.filePath.replace(process.cwd() + '/', '');
      
      return {
        id: font.id,
        name: font.name,
        fontWeight: font.fontWeight,
        isVariableFont: font.isVariableFont,
        description: font.description,
        url: `/${relativePath}` // Add leading slash to make it a proper URL
      };
    });
  }
} 