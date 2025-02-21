import { Injectable } from '@nestjs/common';
import { createCanvas, loadImage, Canvas, registerFont } from 'canvas';
import { EtsyOrder } from '../entities/etsy-order.entity';
import * as path from 'path';
import * as fs from 'fs';

interface StampGenerationResult {
  success: boolean;
  path?: string;
  error?: string;
}

@Injectable()
export class StampGeneratorService {
  private readonly CANVAS_WIDTH = 800;
  private readonly CANVAS_HEIGHT = 600;
  private readonly outputDir = 'uploads/stamps';
  private readonly fontsDir = 'assets/fonts';

  constructor() {
    // 确保输出目录存在
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }

    // 注册字体
    // this.registerFonts();
  }

  private registerFonts() {
    const fontsPath = path.join(process.cwd(), this.fontsDir);
    if (!fs.existsSync(fontsPath)) {
      console.warn('Fonts directory not found, using system fonts');
      return;
    }

    try {
      const fontFiles = fs.readdirSync(fontsPath);
      fontFiles.forEach(fontFile => {
        if (fontFile.match(/\.(ttf|otf)$/i)) {
          const fontPath = path.join(fontsPath, fontFile);
          const fontFamily = path.parse(fontFile).name;
          registerFont(fontPath, { family: fontFamily });
          console.log(`Registered font: ${fontFamily}`);
        }
      });
    } catch (error) {
      console.error('Error registering fonts:', error);
    }
  }

  private getFontForSku(sku: string): string {
    // 根据SKU前缀选择字体
    const skuPrefix = sku.split('-')[0];
    const fontMapping: { [key: string]: string } = {
      'STAMP': 'TimesNewRoman',  // 示例：STAMP-开头的SKU使用Times New Roman字体
      'SEAL': 'Arial',           // 示例：SEAL-开头的SKU使用Arial字体
      'CUSTOM': 'Helvetica'      // 示例：CUSTOM-开头的SKU使用Helvetica字体
    };

    return fontMapping[skuPrefix] || 'Arial'; // 默认使用Arial
  }

  async generateStamp(order: EtsyOrder): Promise<StampGenerationResult> {
    try {
      // 检查SKU图片是否存在
      const skuImagePath = path.join(process.cwd(), 'uploads/sku-images', `${order.sku}.png`);
      if (!fs.existsSync(skuImagePath)) {
        return {
          success: false,
          error: `SKU image not found: ${order.sku}.png`
        };
      }

      // 创建画布
      const canvas = createCanvas(this.CANVAS_WIDTH, this.CANVAS_HEIGHT);
      const ctx = canvas.getContext('2d');

      // 设置白色背景
      ctx.fillStyle = 'white';
      ctx.fillRect(0, 0, this.CANVAS_WIDTH, this.CANVAS_HEIGHT);

      // 加载SKU对应的图片
      const image = await loadImage(skuImagePath);
      // 在画布中央绘制图片
      const scale = Math.min(
        this.CANVAS_WIDTH / image.width * 0.8,
        this.CANVAS_HEIGHT / image.height * 0.8
      );
      const x = (this.CANVAS_WIDTH - image.width * scale) / 2;
      const y = (this.CANVAS_HEIGHT - image.height * scale) / 2;
      ctx.drawImage(image, x, y, image.width * scale, image.height * scale);

      // 获取该SKU对应的字体
      const font = this.getFontForSku(order.sku);
      
      // 添加订单信息文字
      ctx.font = `24px "${font}"`;
      ctx.fillStyle = 'black';
      ctx.textAlign = 'center';
      
      // 添加SKU信息
      ctx.fillText(`SKU: ${order.sku}`, this.CANVAS_WIDTH / 2, 50);
      
      // 添加订单号
      ctx.fillText(`Order: ${order.orderId}`, this.CANVAS_WIDTH / 2, this.CANVAS_HEIGHT - 50);

      // 如果有variations，添加variation信息
      // if (order.variations) {
      //   const variationText = Object.entries(order.variations)
      //     .map(([key, value]) => `${key}: ${value}`)
      //     .join(' | ');
      //   ctx.font = `18px "${font}"`;
      //   ctx.fillText(variationText, this.CANVAS_WIDTH / 2, this.CANVAS_HEIGHT - 80);
      // }

      // 保存图章
      const outputPath = path.join(this.outputDir, `${order.orderId}_${order.sku}.jpg`);
      const buffer = canvas.toBuffer('image/jpeg');
      fs.writeFileSync(outputPath, buffer);

      return {
        success: true,
        path: outputPath
      };
    } catch (error) {
      console.error('Error generating stamp:', error);
      return {
        success: false,
        error: `Failed to generate stamp for order ${order.orderId}: ${error.message}`
      };
    }
  }
} 