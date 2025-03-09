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
  BadRequestException
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiResponse, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { diskStorage } from 'multer';

import { StampsService } from './stamps.service';
import { CreateStampTemplateDto } from './dto/create-stamp-template.dto';
import { GenerateStampDto } from './dto/generate-stamp.dto';

const UPLOAD_DIR = 'uploads/backgrounds';

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

@ApiTags('stamps')
@Controller('stamps')
export class StampsController {
  constructor(private readonly stampsService: StampsService) {}

  @Post('templates')
  @ApiOperation({ summary: 'Create a new stamp template' })
  @ApiResponse({ status: 201, description: 'The stamp template has been successfully created.' })
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
  @ApiOperation({ summary: 'Get a stamp template by ID or SKU' })
  @ApiResponse({ status: 200, description: 'Return the stamp template' })
  @ApiResponse({ status: 404, description: 'Stamp template not found' })
  async findOne(@Param('id') id: string) {
    // Try to parse as number, otherwise use as string (SKU)
    const parsedId = +id;
    if (isNaN(parsedId)) {
      throw new BadRequestException('ID must be a number');
    }
    return this.stampsService.findById(parsedId);
  }

  @Delete('templates/:id')
  @ApiOperation({ summary: 'Delete a stamp template' })
  @ApiResponse({ status: 200, description: 'The stamp template has been successfully deleted' })
  @ApiResponse({ status: 404, description: 'Stamp template not found' })
  async remove(@Param('id', ParseIntPipe) id: number) {
    await this.stampsService.remove(id);
    return { message: 'Template deleted successfully' };
  }

  @Post('generate')
  @ApiOperation({ summary: 'Generate a stamp based on a template' })
  @ApiResponse({ status: 200, description: 'Return the generated stamp image' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async generateStamp(@Body() generateStampDto: GenerateStampDto, @Res() res: Response) {
    const buffer = await this.stampsService.generateStamp(generateStampDto);
    
    // Set appropriate content type based on format
    const format = generateStampDto.format || 'png';
    const contentType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    
    res.set({
      'Content-Type': contentType,
      'Content-Length': buffer.length,
    });
    
    return res.status(HttpStatus.OK).send(buffer);
  }

  @Post('upload-background')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: UPLOAD_DIR,
        filename: (req, file, cb) => {
          // Generate a unique filename
          const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
          const ext = path.extname(file.originalname);
          cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
        },
      }),
      fileFilter: (req, file, cb) => {
        // Accept only image files
        if (!file.mimetype.match(/\/(jpg|jpeg|png|gif)$/)) {
          return cb(new BadRequestException('Only image files are allowed!'), false);
        }
        cb(null, true);
      },
      limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
      },
    }),
  )
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file: {
          type: 'string',
          format: 'binary',
        },
      },
    },
  })
  @ApiOperation({ summary: 'Upload a background image for stamp templates' })
  @ApiResponse({ status: 201, description: 'The background image has been successfully uploaded' })
  async uploadBackground(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    
    // Return the relative path to the uploaded file
    const relativePath = path.join(UPLOAD_DIR, file.filename);
    
    return {
      message: 'File uploaded successfully',
      filePath: relativePath,
      filename: file.filename,
      originalName: file.originalname,
    };
  }
} 