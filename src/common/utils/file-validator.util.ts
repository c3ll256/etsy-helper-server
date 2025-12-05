import { fileTypeFromFile } from 'file-type';
import * as fs from 'fs';
import { BadRequestException } from '@nestjs/common';

/**
 * 允许的图片MIME类型
 */
export const ALLOWED_IMAGE_MIMES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/svg+xml',
] as const;

/**
 * 允许的字体MIME类型
 * 注意：file-type 可能返回不同的MIME类型，需要兼容多种格式
 */
export const ALLOWED_FONT_MIMES = [
  'font/ttf',
  'font/otf',
  'application/font-ttf',
  'application/font-otf',
  'application/font-woff',
  'application/font-woff2',
  'font/woff',
  'font/woff2',
  'application/x-font-ttf',
  'application/x-font-otf',
  'application/x-font-woff',
  'application/x-font-woff2',
] as const;

/**
 * 所有允许的MIME类型（图片 + 字体）
 */
export const ALLOWED_MIMES = [
  ...ALLOWED_IMAGE_MIMES,
  ...ALLOWED_FONT_MIMES,
] as const;

/**
 * 验证文件的实际内容类型
 * SECURITY: 使用文件魔数验证文件类型，防止文件类型伪造攻击
 * 
 * @param filePath 文件路径
 * @param allowedMimes 允许的MIME类型数组
 * @returns 文件类型信息
 * @throws BadRequestException 如果文件类型不匹配
 */
export async function validateFileType(
  filePath: string,
  allowedMimes: readonly string[]
): Promise<{ mime: string; ext: string }> {
  if (!fs.existsSync(filePath)) {
    throw new BadRequestException('文件不存在');
  }

  try {
    const fileType = await fileTypeFromFile(filePath);
    
    if (!fileType) {
      throw new BadRequestException('无法识别文件类型，文件可能已损坏或格式不正确');
    }

    // 检查MIME类型是否在允许列表中
    if (!allowedMimes.includes(fileType.mime)) {
      throw new BadRequestException(
        `不允许的文件类型: ${fileType.mime}。只允许上传图片和字体文件。`
      );
    }

    return fileType;
  } catch (error) {
    if (error instanceof BadRequestException) {
      throw error;
    }
    throw new BadRequestException(`文件类型验证失败: ${error.message}`);
  }
}

/**
 * 验证是否为图片文件
 * @param filePath 文件路径
 * @returns 文件类型信息
 */
export async function validateImageFile(filePath: string): Promise<{ mime: string; ext: string }> {
  return validateFileType(filePath, ALLOWED_IMAGE_MIMES);
}

/**
 * 验证是否为字体文件
 * @param filePath 文件路径
 * @returns 文件类型信息
 */
export async function validateFontFile(filePath: string): Promise<{ mime: string; ext: string }> {
  return validateFileType(filePath, ALLOWED_FONT_MIMES);
}

/**
 * 验证是否为图片或字体文件
 * @param filePath 文件路径
 * @returns 文件类型信息
 */
export async function validateImageOrFontFile(filePath: string): Promise<{ mime: string; ext: string }> {
  return validateFileType(filePath, ALLOWED_MIMES);
}

