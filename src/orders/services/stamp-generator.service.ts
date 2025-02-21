import { Injectable } from '@nestjs/common';
import { createCanvas, loadImage, Canvas } from 'canvas';
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

  constructor() {
    // 确保输出目录存在
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
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

      // 添加订单信息文字
      ctx.font = '24px Arial';
      ctx.fillStyle = 'black';
      ctx.textAlign = 'center';
      
      // 添加SKU信息
      ctx.fillText(`SKU: ${order.sku}`, this.CANVAS_WIDTH / 2, 50);
      
      // 添加订单号
      ctx.fillText(`Order: ${order.orderId}`, this.CANVAS_WIDTH / 2, this.CANVAS_HEIGHT - 50);

      // 如果有variations，添加variation信息
      if (order.variations) {
        const variationText = Object.entries(order.variations)
          .map(([key, value]) => `${key}: ${value}`)
          .join(' | ');
        ctx.font = '18px Arial';
        ctx.fillText(variationText, this.CANVAS_WIDTH / 2, this.CANVAS_HEIGHT - 80);
      }

      // 保存图章
      const outputPath = path.join(this.outputDir, `${order.orderId}_${order.sku}.png`);
      const buffer = canvas.toBuffer('image/png');
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