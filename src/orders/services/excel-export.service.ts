import { Injectable, Logger } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import * as dayjs from 'dayjs';
import * as path from 'path';
import * as fs from 'fs';
import { Order } from '../entities/order.entity';
import * as QRCode from 'qrcode';
import { createCanvas, loadImage } from 'canvas';
import { read, utils, write, WorkSheet, WorkBook } from 'xlsx';

export type ProcessingResult = {
  total: number;
  created: number;
  skipped: number;
  skippedReasons: { orderId: string; transactionId: string; reason: string }[];
  failed: number;
  stamps: { orderId: string; transactionId: string; stampPath: string }[];
  orderDetails: Array<{
    orderId: string;
    transactionId: string;
    status: 'success' | 'skipped' | 'failed';
    reason?: string;
    stampCount?: number;
    originalData: any;
  }>;
};

@Injectable()
export class ExcelExportService {
  private readonly logger = new Logger(ExcelExportService.name);

  /**
   * Create Excel file for exporting orders
   */
  async createOrdersExcelForExport(excelData: any[]): Promise<string> {
    try {
      // Build workbook and worksheet with ExcelJS to support images (QR codes)
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('订单信息');

      // Define columns (place QR as the last column; merge date+time)
      worksheet.columns = [
        { header: '序号', key: 'index', width: 10 },
        { header: '订单号', key: 'orderId', width: 20 },
        { header: '客户名称', key: 'customerName', width: 20 },
        { header: '收件人名称', key: 'recipientName', width: 20 },
        { header: 'SKU', key: 'sku', width: 20 },
        { header: '解析前的variants', key: 'variantsBefore', width: 40 },
        { header: '解析后的variants', key: 'variantsAfter', width: 40 },
        { header: '下单时间', key: 'orderDateTime', width: 20 },
        { header: '文件名', key: 'fileName', width: 30 },
        { header: '二维码', key: 'qr', width: 22 }
      ];

      // Style header
      const headerRow = worksheet.getRow(1);
      headerRow.font = { bold: true };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
      headerRow.height = 25;

      // Pre-calc the qr column index (0-based for image anchor)
      const qrColZeroBased = worksheet.columns.findIndex(c => c.key === 'qr');

      for (let i = 0; i < excelData.length; i++) {
        const rowData = excelData[i];
        const rowNumber = i + 2; // data starts at row 2

        // Extract values
        const orderId: string = rowData['订单号'] || '';
        const customerName: string = rowData['客户名称'] || '';
        const recipientName: string = rowData['收件人名称'] || '';
        const sku: string = rowData['SKU'] || '';
        const variantsBefore: string = rowData['解析前的variants'] || '';
        const variantsAfter: string = rowData['解析后的variants'] || '';
        const orderDateTimeRaw: Date | string = rowData['下单时间'] || rowData['下单日期'] || rowData['导入时间'];
        const fileName: string = rowData['文件名'] || '';

        // Format combined datetime
        const orderDateTime = orderDateTimeRaw ? new Date(orderDateTimeRaw) : null;
        const orderDateTimeText = orderDateTime ? dayjs(orderDateTime).format('YYYY-MM-DD HH:mm:ss') : '';

        // Fill row cells
        const dataRow = worksheet.getRow(rowNumber);
        dataRow.getCell('index').value = rowData['序号'] || '';
        dataRow.getCell('orderId').value = orderId;
        dataRow.getCell('customerName').value = customerName;
        dataRow.getCell('recipientName').value = recipientName;
        dataRow.getCell('sku').value = sku;
        dataRow.getCell('variantsBefore').value = variantsBefore;
        dataRow.getCell('variantsAfter').value = variantsAfter;
        dataRow.getCell('orderDateTime').value = orderDateTimeText;
        dataRow.getCell('fileName').value = fileName;

        // Adjust row height to make room for QR + caption
        dataRow.height = 120;

        // QR Code generation and placement (compose QR + caption into one image)
        if (orderId) {
          try {
            const dataUrl = await QRCode.toDataURL(orderId, { type: 'image/png', scale: 6, margin: 1 } as any);
            const qrImage = await loadImage(dataUrl);
            const padding = 8;
            const text = orderId;

            // Measure text using a temporary context
            const measureCanvas = createCanvas(1, 1);
            const measureCtx = measureCanvas.getContext('2d');
            measureCtx.font = '16px sans-serif';
            const textWidth = Math.ceil(measureCtx.measureText(text).width);
            const textHeight = 22; // approximate line height for 16px font

            const compositeWidth = Math.max(qrImage.width + padding * 2, textWidth + padding * 2);
            const compositeHeight = padding + qrImage.height + padding + textHeight;

            const canvas = createCanvas(compositeWidth, compositeHeight);
            const ctx = canvas.getContext('2d');
            // White background
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, compositeWidth, compositeHeight);
            // Draw QR centered
            const qrX = Math.floor((compositeWidth - qrImage.width) / 2);
            ctx.drawImage(qrImage, qrX, padding);
            // Draw caption centered
            ctx.fillStyle = '#000000';
            ctx.font = '16px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const captionY = padding + qrImage.height + Math.floor(textHeight / 2);
            ctx.fillText(text, compositeWidth / 2, captionY);

            const composedBuffer = canvas.toBuffer('image/png');
            const imageId = workbook.addImage({ base64: composedBuffer.toString('base64'), extension: 'png' });

            // Preserve aspect ratio, fit within 120x120 box
            const maxW = 120;
            const maxH = 120;
            const scale = Math.min(maxW / compositeWidth, maxH / compositeHeight, 1);
            const extWidth = Math.round(compositeWidth * scale);
            const extHeight = Math.round(compositeHeight * scale);

            worksheet.addImage(imageId, {
              tl: { col: qrColZeroBased, row: rowNumber - 1 },
              ext: { width: extWidth, height: extHeight }
            });
          } catch (e) {
            const qrCell = dataRow.getCell('qr');
            qrCell.value = 'QR生成失败';
            qrCell.alignment = { vertical: 'middle', horizontal: 'center' };
            this.logger.warn(`Failed to generate QR for order ${orderId}: ${e.message}`);
          }
        }

        // Style alignment for the row
        dataRow.alignment = { vertical: 'middle', horizontal: 'center' };
      }

      // Create output directory
      const exportDir = path.join(process.cwd(), 'uploads', 'exports');
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }

      // Save workbook
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const excelFileName = `orders_info_${timestamp}.xlsx`;
      const excelFilePath = path.join(exportDir, excelFileName);
      await workbook.xlsx.writeFile(excelFilePath);

      this.logger.log(`Excel file with QR created at: ${excelFilePath}`);
      return excelFilePath;
    } catch (error) {
      this.logger.error(`Failed to create Excel file: ${error.message}`, error.stack);
      throw new Error(`Failed to create Excel file: ${error.message}`);
    }
  }

  /**
   * Create Excel file with stamps for orders
   */
  async createOrdersExcelWithStamps(excelData: any[], fileName: string): Promise<string> {
    try {
      // Create workbook and worksheet
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('订单印章');

      // Set column widths and properties (add last QR column, merge datetime)
      worksheet.columns = [
        { header: '序号', key: 'index', width: 10 },
        { header: '订单号', key: 'orderId', width: 20 },
        { header: '设计图', key: 'image', width: 40 },
        { header: '数量', key: 'quantity', width: 10 },
        { header: '尺寸', key: 'size', width: 15 },
        { header: 'SKU', key: 'sku', width: 20 },
        { header: '店铺', key: 'shop', width: 20 },
        { header: '下单时间', key: 'orderDateTime', width: 22 },
        { header: '二维码', key: 'qr', width: 22 }
      ];

      // Style the header row
      const headerRow = worksheet.getRow(1);
      headerRow.font = { bold: true };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
      headerRow.height = 25;

      // Pre-calc the qr column index (0-based for image anchor)
      const qrColZeroBased = worksheet.columns.findIndex(c => c.key === 'qr');

      // Process each row
      for (let i = 0; i < excelData.length; i++) {
        const row = excelData[i];
        const rowNumber = i + 2; // +2 because row 1 is header

        // Add row data
        const dataRow = worksheet.getRow(rowNumber);
        dataRow.getCell('index').value = row['序号'];
        dataRow.getCell('orderId').value = row['订单号'];
        dataRow.getCell('quantity').value = row['数量'];
        dataRow.getCell('size').value = row['尺寸'];
        dataRow.getCell('sku').value = row['SKU'];
        dataRow.getCell('shop').value = row['店铺'];
        const dtRaw = row['下单时间'] || row['导入时间'];
        dataRow.getCell('orderDateTime').value = dtRaw ? dayjs(new Date(dtRaw)).format('YYYY-MM-DD HH:mm:ss') : '';

        // Set row height for image
        dataRow.height = 120;

        // Handle image
        if (row['设计图']) {
          try {
            const imagePath = path.join(process.cwd(), 'uploads', row['设计图']);
            if (fs.existsSync(imagePath)) {
              const imageId = workbook.addImage({
                filename: imagePath,
                extension: 'png',
              });

              // Calculate image dimensions based on template size
              const templateWidth = parseInt(row['尺寸'].split('x')[0]);
              const templateHeight = parseInt(row['尺寸'].split('x')[1]);
              const aspectRatio = templateWidth / templateHeight;

              // Base size (in Excel units)
              const baseHeight = 100;
              const width = baseHeight * aspectRatio;
              const height = baseHeight;

              // Add image to worksheet with calculated dimensions
              worksheet.addImage(imageId, {
                tl: { col: 2, row: rowNumber - 1 }, // -1 because row is 1-based
                ext: { width, height }
              });
            } else {
              dataRow.getCell('image').value = '图片不存在';
              this.logger.warn(`Image not found: ${imagePath}`);
            }
          } catch (error) {
            this.logger.error(`Failed to process image for row ${rowNumber}: ${error.message}`);
            dataRow.getCell('image').value = '图片处理失败';
          }
        }

        // QR image composed with caption (orderId)
        const orderId = row['订单号'];
        if (orderId) {
          try {
            const dataUrl = await QRCode.toDataURL(orderId, { type: 'image/png', scale: 6, margin: 1 } as any);
            const qrImage = await loadImage(dataUrl);
            const padding = 8;
            const text = orderId;

            // Measure text using a temporary context
            const measureCanvas = createCanvas(1, 1);
            const measureCtx = measureCanvas.getContext('2d');
            measureCtx.font = '16px sans-serif';
            const textWidth = Math.ceil(measureCtx.measureText(text).width);
            const textHeight = 22; // approximate line height for 16px font

            const compositeWidth = Math.max(qrImage.width + padding * 2, textWidth + padding * 2);
            const compositeHeight = padding + qrImage.height + padding + textHeight;

            const canvas = createCanvas(compositeWidth, compositeHeight);
            const ctx = canvas.getContext('2d');
            // White background
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(0, 0, compositeWidth, compositeHeight);
            // Draw QR centered
            const qrX = Math.floor((compositeWidth - qrImage.width) / 2);
            ctx.drawImage(qrImage, qrX, padding);
            // Draw caption centered
            ctx.fillStyle = '#000000';
            ctx.font = '16px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const captionY = padding + qrImage.height + Math.floor(textHeight / 2);
            ctx.fillText(text, compositeWidth / 2, captionY);

            const composedBuffer = canvas.toBuffer('image/png');
            const imageId = workbook.addImage({ base64: composedBuffer.toString('base64'), extension: 'png' });

            // Preserve aspect ratio, fit within 120x120 box
            const maxW = 120;
            const maxH = 120;
            const scale = Math.min(maxW / compositeWidth, maxH / compositeHeight, 1);
            const extWidth = Math.round(compositeWidth * scale);
            const extHeight = Math.round(compositeHeight * scale);

            worksheet.addImage(imageId, {
              tl: { col: qrColZeroBased, row: rowNumber - 1 },
              ext: { width: extWidth, height: extHeight }
            });
          } catch (e) {
            const qrCell = dataRow.getCell('qr');
            qrCell.value = 'QR生成失败';
            qrCell.alignment = { vertical: 'middle', horizontal: 'center' };
            this.logger.warn(`Failed to generate QR for order ${orderId}: ${e.message}`);
          }
        }

        // Style the row
        dataRow.alignment = { vertical: 'middle', horizontal: 'center' };
      }

      // Create output directory
      const exportDir = path.join(process.cwd(), 'uploads', 'exports');
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }

      // Save workbook
      const filePath = path.join(exportDir, fileName);
      await workbook.xlsx.writeFile(filePath);

      // Return relative path
      return path.relative(process.cwd(), filePath);
    } catch (error) {
      this.logger.error(`Failed to create Excel file with stamps: ${error.message}`, error.stack);
      throw new Error(`Failed to create Excel file: ${error.message}`);
    }
  }

  /**
   * Create processing report Excel file
   */
  async createProcessingReportExcel(
    originalData: any[],
    result: ProcessingResult
  ): Promise<string> {
    try {
      const workbook = new ExcelJS.Workbook();
      const processTime = dayjs().format('YYYY-MM-DD HH:mm:ss');

      // Create summary sheet
      const summarySheet = workbook.addWorksheet('处理摘要');
      summarySheet.columns = [
        { header: '项目', key: 'item', width: 30 },
        { header: '值', key: 'value', width: 30 }
      ];

      const headerRow = summarySheet.getRow(1);
      headerRow.font = { bold: true };
      headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
      headerRow.height = 25;

      const summaryData = [
        { item: '处理时间', value: processTime },
        { item: '总订单数', value: result.total },
        { item: '成功处理', value: result.created },
        { item: '跳过订单', value: result.skipped },
        { item: '失败订单', value: result.failed }
      ];

      summaryData.forEach((row, index) => {
        const dataRow = summarySheet.getRow(index + 2);
        dataRow.getCell('item').value = row.item;
        dataRow.getCell('value').value = row.value;
        dataRow.alignment = { vertical: 'middle', horizontal: 'left' };
      });

      // Create successful orders sheet
      const successSheet = workbook.addWorksheet('成功订单');
      successSheet.columns = [
        { header: '序号', key: 'index', width: 10 },
        { header: '订单号', key: 'orderId', width: 20 },
        { header: '交易ID', key: 'transactionId', width: 20 },
        { header: 'SKU', key: 'sku', width: 20 },
        { header: '图章路径', key: 'stampPath', width: 50 },
        { header: '客户名称', key: 'buyer', width: 20 },
        { header: '收件人', key: 'shipName', width: 20 }
      ];

      const successHeaderRow = successSheet.getRow(1);
      successHeaderRow.font = { bold: true };
      successHeaderRow.alignment = { vertical: 'middle', horizontal: 'center' };
      successHeaderRow.height = 25;

      // Map stamps to original data for additional info
      const orderMap = new Map<string, any>();
      originalData.forEach(item => {
        const orderId = item['Order ID']?.toString() || '';
        const transactionId = item['Transaction ID']?.toString() || '';
        const key = `${orderId}_${transactionId}`;
        if (!orderMap.has(key)) {
          orderMap.set(key, item);
        }
      });

      result.stamps.forEach((stamp, index) => {
        const dataRow = successSheet.getRow(index + 2);
        // Match by transaction ID first (more reliable), then by order ID
        const originalItem = Array.from(orderMap.values()).find(
          item => item['Transaction ID']?.toString() === stamp.transactionId ||
                  item['Order ID']?.toString() === stamp.orderId
        );

        dataRow.getCell('index').value = index + 1;
        dataRow.getCell('orderId').value = stamp.orderId;
        dataRow.getCell('transactionId').value = stamp.transactionId;
        dataRow.getCell('sku').value = originalItem?.['SKU']?.toString() || '';
        dataRow.getCell('stampPath').value = stamp.stampPath;
        dataRow.getCell('buyer').value = originalItem?.['Buyer']?.toString() || '';
        dataRow.getCell('shipName').value = originalItem?.['Ship Name']?.toString() || '';
        dataRow.alignment = { vertical: 'middle', horizontal: 'left' };
      });

      // Create skipped orders sheet
      const skippedSheet = workbook.addWorksheet('跳过订单');
      skippedSheet.columns = [
        { header: '序号', key: 'index', width: 10 },
        { header: '订单号', key: 'orderId', width: 20 },
        { header: '交易ID', key: 'transactionId', width: 20 },
        { header: 'SKU', key: 'sku', width: 20 },
        { header: '跳过原因', key: 'reason', width: 50 },
        { header: '客户名称', key: 'buyer', width: 20 }
      ];

      const skippedHeaderRow = skippedSheet.getRow(1);
      skippedHeaderRow.font = { bold: true };
      skippedHeaderRow.alignment = { vertical: 'middle', horizontal: 'center' };
      skippedHeaderRow.height = 25;

      result.skippedReasons.forEach((item, index) => {
        const dataRow = skippedSheet.getRow(index + 2);
        const originalItem = Array.from(orderMap.values()).find(
          orig => orig['Order ID']?.toString() === item.orderId || 
                  orig['Transaction ID']?.toString() === item.transactionId
        );

        dataRow.getCell('index').value = index + 1;
        dataRow.getCell('orderId').value = item.orderId;
        dataRow.getCell('transactionId').value = item.transactionId;
        dataRow.getCell('sku').value = originalItem?.['SKU']?.toString() || '';
        dataRow.getCell('reason').value = item.reason;
        dataRow.getCell('buyer').value = originalItem?.['Buyer']?.toString() || '';
        dataRow.alignment = { vertical: 'middle', horizontal: 'left' };
      });

      // Create all orders detail sheet
      const allOrdersSheet = workbook.addWorksheet('所有订单');
      allOrdersSheet.columns = [
        { header: '序号', key: 'index', width: 10 },
        { header: '处理状态', key: 'status', width: 15 },
        { header: '订单号', key: 'orderId', width: 20 },
        { header: '交易ID', key: 'transactionId', width: 20 },
        { header: 'SKU', key: 'sku', width: 20 },
        { header: '客户名称', key: 'buyer', width: 20 },
        { header: '收件人', key: 'shipName', width: 20 },
        { header: '收件地址1', key: 'shipAddress1', width: 30 },
        { header: '收件地址2', key: 'shipAddress2', width: 30 },
        { header: '城市', key: 'shipCity', width: 15 },
        { header: '州/省', key: 'shipState', width: 15 },
        { header: '邮编', key: 'shipZipcode', width: 15 },
        { header: '国家', key: 'shipCountry', width: 15 },
        { header: '商品名称', key: 'itemName', width: 30 },
        { header: '数量', key: 'quantity', width: 10 },
        { header: '价格', key: 'price', width: 15 },
        { header: '付款日期', key: 'datePaid', width: 20 },
        { header: 'Variations', key: 'variations', width: 50 },
        { header: '生成图章数', key: 'stampCount', width: 15 },
        { header: '处理结果/原因', key: 'reason', width: 50 }
      ];

      const allOrdersHeaderRow = allOrdersSheet.getRow(1);
      allOrdersHeaderRow.font = { bold: true };
      allOrdersHeaderRow.alignment = { vertical: 'middle', horizontal: 'center' };
      allOrdersHeaderRow.height = 25;

      // Process all orders in order (use orderDetails if available, otherwise fallback to reconstructing from data)
      const orderDetailsToProcess = result.orderDetails && result.orderDetails.length > 0 
        ? result.orderDetails 
        : originalData.map((item, idx) => {
            const orderId = item['Order ID']?.toString() || 'Unknown';
            const transactionId = item['Transaction ID']?.toString() || 'Unknown';
            // Try to match with skipped reasons or stamps to determine status
            const skippedReason = result.skippedReasons.find(
              sr => sr.orderId === orderId || sr.transactionId === transactionId
            );
            const hasStamps = result.stamps.some(
              s => s.orderId === orderId || s.transactionId === transactionId
            );
            
            let status: 'success' | 'skipped' | 'failed' = 'skipped';
            let reason = '';
            let stampCount = 0;
            
            if (hasStamps) {
              status = 'success';
              stampCount = result.stamps.filter(
                s => s.orderId === orderId || s.transactionId === transactionId
              ).length;
            } else if (skippedReason) {
              status = 'skipped';
              reason = skippedReason.reason;
            }
            
            return {
              orderId,
              transactionId,
              status,
              reason,
              stampCount,
              originalData: item
            };
          });

      orderDetailsToProcess.forEach((detail, index) => {
        const dataRow = allOrdersSheet.getRow(index + 2);
        const originalData = detail.originalData;

        // Status with color coding
        const statusText = detail.status === 'success' ? '成功' : 
                          detail.status === 'skipped' ? '跳过' : '失败';
        dataRow.getCell('index').value = index + 1;
        dataRow.getCell('status').value = statusText;
        dataRow.getCell('orderId').value = detail.orderId;
        dataRow.getCell('transactionId').value = detail.transactionId;
        dataRow.getCell('sku').value = originalData?.['SKU']?.toString() || '';
        dataRow.getCell('buyer').value = originalData?.['Buyer']?.toString() || '';
        dataRow.getCell('shipName').value = originalData?.['Ship Name']?.toString() || '';
        dataRow.getCell('shipAddress1').value = originalData?.['Ship Address1']?.toString() || '';
        dataRow.getCell('shipAddress2').value = originalData?.['Ship Address2']?.toString() || '';
        dataRow.getCell('shipCity').value = originalData?.['Ship City']?.toString() || '';
        dataRow.getCell('shipState').value = originalData?.['Ship State']?.toString() || '';
        dataRow.getCell('shipZipcode').value = originalData?.['Ship Zipcode']?.toString() || '';
        dataRow.getCell('shipCountry').value = originalData?.['Ship Country']?.toString() || '';
        dataRow.getCell('itemName').value = originalData?.['Item Name']?.toString() || '';
        dataRow.getCell('quantity').value = originalData?.['Quantity'] ? Number(originalData['Quantity']) : '';
        dataRow.getCell('price').value = originalData?.['Price'] ? Number(originalData['Price']) : '';
        
        // Format date
        const datePaid = originalData?.['Date Paid'];
        if (datePaid) {
          const parsedDate = this.parseDate(datePaid);
          dataRow.getCell('datePaid').value = parsedDate ? dayjs(parsedDate).format('YYYY-MM-DD HH:mm:ss') : '';
        } else {
          dataRow.getCell('datePaid').value = '';
        }
        
        dataRow.getCell('variations').value = originalData?.['Variations']?.toString() || '';
        dataRow.getCell('stampCount').value = detail.stampCount || '';
        dataRow.getCell('reason').value = detail.reason || '';

        // Color code status column
        const statusCell = dataRow.getCell('status');
        if (detail.status === 'success') {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FF90EE90' } // Light green
          };
        } else if (detail.status === 'skipped') {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFE4B5' } // Light yellow
          };
        } else if (detail.status === 'failed') {
          statusCell.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFFFB6C1' } // Light pink
          };
        }

        dataRow.alignment = { vertical: 'middle', horizontal: 'left' };
        dataRow.height = 20;
      });

      // Create output directory
      const exportDir = path.join(process.cwd(), 'uploads', 'exports');
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }

      // Save workbook
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const excelFileName = `processing_report_${timestamp}.xlsx`;
      const excelFilePath = path.join(exportDir, excelFileName);
      await workbook.xlsx.writeFile(excelFilePath);

      this.logger.log(`Processing report Excel created at: ${excelFilePath}`);
      return excelFilePath;
    } catch (error) {
      this.logger.error(`Failed to create processing report Excel: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Prepare data for exporting orders to Excel
   */
  prepareOrdersExportData(orders: Order[]): any[] {
    const excelData = [];
    
    // 按订单号(platformOrderId 或 orderId)对订单进行分组
    const orderGroups = new Map<string, Array<{order: Order, stamps: string[]}>>(); 
    
    for (const order of orders) {
      if (order.orderType === 'etsy' && order.etsyOrder) {
        // 使用平台订单ID或Etsy订单ID作为分组键
        const groupKey = order.platformOrderId || order.etsyOrder.orderId || order.id.toString();
        
        if (!orderGroups.has(groupKey)) {
          orderGroups.set(groupKey, []);
        }
        
        // 将订单及其图章URL添加到组中
        orderGroups.get(groupKey).push({
          order,
          stamps: order.etsyOrder.stampImageUrls || []
        });
      }
    }
    
    // 对订单组进行排序
    const sortedOrderGroupKeys = Array.from(orderGroups.keys()).sort();
    let orderIndex = 0;
    
    // 处理每个订单组
    for (const groupKey of sortedOrderGroupKeys) {
      const orderWithStamps = orderGroups.get(groupKey);
      orderIndex++; // 每个不同的订单号递增订单索引
      
      // 收集该订单组的所有图章URL
      const allStampsInGroup: Array<{stamp: string, order: Order}> = [];
      
      for (const item of orderWithStamps) {
        for (const stamp of item.stamps) {
          allStampsInGroup.push({
            stamp,
            order: item.order
          });
        }
      }
      
      // 为该订单组的每个图章创建Excel数据行
      for (let stampIndex = 0; stampIndex < allStampsInGroup.length; stampIndex++) {
        const { stamp, order } = allStampsInGroup[stampIndex];
        
        excelData.push({
          '序号': `${orderIndex}-${stampIndex + 1}`,
          '订单号': order.etsyOrder.orderId,
          'SKU': order.etsyOrder.sku || 'N/A',
          '解析前的variants': order.etsyOrder.originalVariations || 'N/A',
          '解析后的variants': JSON.stringify(order.etsyOrder.variations) || 'N/A',
          '下单日期': order.platformOrderDate || order.createdAt,
          '文件名': `${orderIndex}-${stampIndex + 1}${path.extname(stamp)}`
        });
      }
    }
    
    return excelData;
  }

  /**
   * Generate Excel file from data
   */
  generateExcelFile(excelData: any[]): string {
    // Create workbook and worksheet
    const worksheet: WorkSheet = utils.json_to_sheet(excelData);
    const workbook: WorkBook = utils.book_new();
    utils.book_append_sheet(workbook, worksheet, '订单信息');
    
    // Set column widths
    worksheet['!cols'] = [
      { wch: 10 },  // 序号
      { wch: 20 },  // 订单号
      { wch: 15 },  // SKU
      { wch: 40 },  // 解析前的variants
      { wch: 40 },  // 解析后的variants
      { wch: 20 },  // 下单日期
      { wch: 15 },  // 文件名
    ];
    
    // Create output directory
    const exportDir = path.join(process.cwd(), 'uploads', 'exports');
    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }
    
    // Create file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const excelFileName = `orders_info_${timestamp}.xlsx`;
    const excelFilePath = path.join(exportDir, excelFileName);
    
    const excelBuffer = write(workbook, { bookType: 'xlsx', type: 'buffer' });
    fs.writeFileSync(excelFilePath, excelBuffer);
    
    this.logger.log(`Excel file created at: ${excelFilePath}`);
    
    return excelFilePath;
  }

  /**
   * Parse date string that might be in various formats including dd/mm/yyyy
   */
  private parseDate(input: any): Date | null {
    if (input === null || input === undefined) return null;

    try {
      // If it's already a Date
      if (input instanceof Date && !isNaN(input.getTime())) {
        return input;
      }

      // If it's an Excel serial number
      if (typeof input === 'number' && isFinite(input)) {
        // Excel (1900-based) serial number to JS Date
        const millis = Math.round((input - 25569) * 86400 * 1000);
        const d = new Date(millis);
        return isNaN(d.getTime()) ? null : d;
      }

      const dateStr = String(input).trim();
      if (!dateStr) return null;

      // Try dayjs strict with a broad set of patterns
      const formats = [
        'M/D/YYYY', 'MM/DD/YYYY', 'M/D/YY', 'MM/DD/YY',
        'M/D/YYYY H:mm', 'MM/DD/YYYY H:mm', 'M/D/YYYY HH:mm', 'MM/DD/YYYY HH:mm',
        'M/D/YYYY h:mm A', 'MM/DD/YYYY h:mm A',
        'YYYY-MM-DD', 'YYYY/MM/DD', 'YYYY-MM-DD HH:mm', 'YYYY/MM/DD HH:mm', 'YYYY-MM-DD HH:mm:ss', 'YYYY/MM/DD HH:mm:ss',
        'DD/MM/YYYY', 'DD-MM-YYYY'
      ];

      const parsed = dayjs(dateStr, formats, true);
      if (parsed.isValid()) {
        return parsed.toDate();
      }

      // Fallback to native Date
      const jsDate = new Date(dateStr);
      return isNaN(jsDate.getTime()) ? null : jsDate;
    } catch (error) {
      this.logger.warn(`Failed to parse date: ${input}`);
      return null;
    }
  }
}

