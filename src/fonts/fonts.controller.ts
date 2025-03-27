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
  Req
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody, ApiQuery } from '@nestjs/swagger';
import * as fs from 'fs';
import * as path from 'path';
import { diskStorage } from 'multer';

import { FontsService } from './fonts.service';
import { CreateFontDto } from './dto/create-font.dto';

const UPLOADS_DIR = 'uploads/fonts';

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

@ApiTags('fonts')
@Controller('fonts')
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
        variableAxes: {
          type: 'string',
          description: 'JSON string of variable font axes (e.g., {"wght": {"min": 100, "max": 900}})',
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
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
          const ext = path.extname(file.originalname);
          const filename = `font-${uniqueSuffix}${ext}`;
          cb(null, filename);
        },
      }),
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
    @Body('variableAxes') variableAxesStr?: string,
  ) {
    if (!file) {
      throw new BadRequestException('Font file is required');
    }
    
    if (!name) {
      throw new BadRequestException('Font name is required');
    }
    
    // 创建 DTO 对象
    const createFontDto = new CreateFontDto();
    createFontDto.name = name;
    createFontDto.fontWeight = fontWeight;
    createFontDto.isVariableFont = isVariableFontStr === 'true';
    createFontDto.description = description;
    
    // 处理 variableAxes JSON 字符串
    if (variableAxesStr) {
      try {
        createFontDto.variableAxes = JSON.parse(variableAxesStr);
      } catch (e) {
        throw new BadRequestException('Invalid variableAxes JSON format');
      }
    }
    
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
        variableAxes: font.variableAxes,
        description: font.description,
        url: `/${relativePath}` // Add leading slash to make it a proper URL
      };
    });
  }
} 