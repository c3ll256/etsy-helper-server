import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  ParseIntPipe,
  Post,
  Query,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { validateImageFile } from '../common/utils/file-validator.util';
import { User } from '../users/entities/user.entity';
import { QueryRattleIconsDto } from './dto/query-rattle-icons.dto';
import { RattleIconLibraryService } from './rattle-icon-library.service';

const RATTLE_ICON_UPLOAD_DIR = 'uploads/icons';

if (!fs.existsSync(RATTLE_ICON_UPLOAD_DIR)) {
  fs.mkdirSync(RATTLE_ICON_UPLOAD_DIR, { recursive: true });
}

function sanitizeExtension(originalname: string): string {
  const ext = path.extname(originalname).toLowerCase();
  const sanitizedExt = ext.replace(/[^a-z0-9]/g, '');
  return sanitizedExt.slice(0, 10);
}

function normalizeAssetName(name: string): string {
  const base = name.trim().replace(/\.[^/.]+$/, '');
  return base || `icon-${Date.now()}`;
}

@ApiTags('rattle-icons')
@Controller('rattle-icons')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class RattleIconLibraryController {
  constructor(private readonly rattleIconLibraryService: RattleIconLibraryService) {}

  @Get()
  @ApiOperation({ summary: '获取摇铃 icon 资产列表' })
  @ApiResponse({ status: 200, description: '成功返回摇铃 icon 列表' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: '页码，默认 1' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: '每页数量，默认 20' })
  @ApiQuery({ name: 'search', required: false, type: String, description: '按 name 模糊搜索' })
  async list(
    @CurrentUser() user: User,
    @Query('page') pageRaw?: string,
    @Query('limit') limitRaw?: string,
    @Query('search') search?: string,
  ) {
    const query: QueryRattleIconsDto = {};

    if (pageRaw !== undefined) {
      const page = Number(pageRaw);
      if (!Number.isInteger(page) || page < 1) {
        throw new BadRequestException('page must be an integer greater than 0');
      }
      query.page = page;
    }

    if (limitRaw !== undefined) {
      const limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new BadRequestException('limit must be an integer greater than 0');
      }
      query.limit = limit;
    }

    if (search) {
      query.search = search;
    }

    return this.rattleIconLibraryService.list(query, user);
  }

  @Post('upload')
  @ApiOperation({ summary: '上传摇铃 icon 并写入资产库' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: 'icon 图片文件（png/jpg/jpeg/svg）',
        },
        name: {
          type: 'string',
          description: 'icon 名称',
        },
      },
      required: ['file', 'name'],
    },
  })
  @ApiResponse({ status: 201, description: '上传成功并返回资产信息' })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: RATTLE_ICON_UPLOAD_DIR,
        filename: (req, file, cb) => {
          const sanitizedExt = sanitizeExtension(file.originalname);
          const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
          cb(null, `${uniqueSuffix}${sanitizedExt}`);
        },
      }),
      limits: {
        fileSize: 10 * 1024 * 1024,
      },
      fileFilter: (req, file, cb) => {
        const allowedMimes = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml'];
        const allowedExts = ['.png', '.jpg', '.jpeg', '.svg'];
        const ext = path.extname(file.originalname).toLowerCase();

        if (allowedMimes.includes(file.mimetype) && allowedExts.includes(ext)) {
          cb(null, true);
          return;
        }

        cb(new BadRequestException('仅支持 PNG、JPG 或 SVG 格式的图片'), false);
      },
    }),
  )
  async upload(
    @CurrentUser() user: User,
    @UploadedFile() file: Express.Multer.File,
    @Body('name') name: string,
  ) {
    if (!file) {
      throw new BadRequestException('未提供文件或文件上传失败');
    }

    if (!name || !name.trim()) {
      try {
        fs.unlinkSync(file.path);
      } catch (error) {
        // ignore cleanup errors
      }
      throw new BadRequestException('name is required');
    }

    try {
      await validateImageFile(file.path);
    } catch (error) {
      if (fs.existsSync(file.path)) {
        fs.unlinkSync(file.path);
      }
      throw new BadRequestException(error.message || '文件类型验证失败，只允许上传图片文件');
    }

    const filePath = `${RATTLE_ICON_UPLOAD_DIR}/${file.filename}`;
    const asset = await this.rattleIconLibraryService.createAsset({
      userId: user.id as string,
      name: name.trim(),
      filePath,
      mimeType: file.mimetype,
      width: null,
      height: null,
    });

    return {
      id: asset.id,
      name: asset.name,
      filePath: asset.filePath,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
      createdAt: asset.createdAt,
    };
  }

  @Post('upload-batch')
  @ApiOperation({ summary: '批量上传摇铃 icon 并写入资产库' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          items: {
            type: 'string',
            format: 'binary',
          },
          description: 'icon 图片文件列表（png/jpg/jpeg/svg）',
        },
      },
      required: ['files'],
    },
  })
  @ApiResponse({ status: 201, description: '批量上传成功并返回资产信息列表' })
  @UseInterceptors(
    AnyFilesInterceptor({
      storage: diskStorage({
        destination: RATTLE_ICON_UPLOAD_DIR,
        filename: (req, file, cb) => {
          const sanitizedExt = sanitizeExtension(file.originalname);
          const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
          cb(null, `${uniqueSuffix}${sanitizedExt}`);
        },
      }),
      limits: {
        fileSize: 10 * 1024 * 1024,
      },
      fileFilter: (req, file, cb) => {
        const allowedMimes = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml'];
        const allowedExts = ['.png', '.jpg', '.jpeg', '.svg'];
        const ext = path.extname(file.originalname).toLowerCase();

        if (allowedMimes.includes(file.mimetype) && allowedExts.includes(ext)) {
          cb(null, true);
          return;
        }

        cb(new BadRequestException('仅支持 PNG、JPG 或 SVG 格式的图片'), false);
      },
    }),
  )
  async uploadBatch(
    @CurrentUser() user: User,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('未提供文件或文件上传失败');
    }

    const results: Array<{
      id: number;
      name: string;
      filePath: string;
      mimeType: string;
      width: number | null;
      height: number | null;
      createdAt: Date;
    }> = [];

    for (const file of files) {
      try {
        await validateImageFile(file.path);
      } catch (error) {
        if (fs.existsSync(file.path)) {
          fs.unlinkSync(file.path);
        }
        throw new BadRequestException(
          `文件 ${file.originalname} 验证失败: ${error.message || '仅允许上传图片文件'}`,
        );
      }

      const filePath = `${RATTLE_ICON_UPLOAD_DIR}/${file.filename}`;
      const asset = await this.rattleIconLibraryService.createAsset({
        userId: user.id as string,
        name: normalizeAssetName(file.originalname),
        filePath,
        mimeType: file.mimetype,
        width: null,
        height: null,
      });

      results.push({
        id: asset.id,
        name: asset.name,
        filePath: asset.filePath,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
        createdAt: asset.createdAt,
      });
    }

    return {
      items: results,
      total: results.length,
    };
  }

  @Delete(':id')
  @ApiOperation({ summary: '删除摇铃 icon 资产（软删除）' })
  @ApiResponse({ status: 200, description: '删除成功' })
  async remove(@Param('id', ParseIntPipe) id: number, @CurrentUser() user: User) {
    await this.rattleIconLibraryService.remove(id, user);
    return { message: 'Rattle icon asset deleted successfully' };
  }

  @Patch(':id/name')
  @ApiOperation({ summary: '更新 icon 名称' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '新的 icon 名称' },
      },
      required: ['name'],
    },
  })
  async rename(
    @Param('id', ParseIntPipe) id: number,
    @Body('name') name: string,
    @CurrentUser() user: User,
  ) {
    if (!name || !name.trim()) {
      throw new BadRequestException('name is required');
    }

    const updated = await this.rattleIconLibraryService.rename(id, name, user);
    return {
      id: updated.id,
      name: updated.name,
      filePath: updated.filePath,
      mimeType: updated.mimeType,
      width: updated.width,
      height: updated.height,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }
}
