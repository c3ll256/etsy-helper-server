import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Font } from '../../fonts/entities/font.entity';

// FontSizeAdjustment interface to handle the data returned from Python
export interface FontSizeAdjustment {
  originalSize: number;
  scaledSize: number;
  finalSize: number;
  adjustedSize: number;
  scaleFactor: number;
  textScaleFactor: number;
}

@Injectable()
export class PythonStampService {
  private readonly logger = new Logger(PythonStampService.name);
  private readonly pythonScriptPath: string;
  private readonly outputDir = 'uploads/stamps';

  constructor(
    @InjectRepository(Font)
    private readonly fontRepository: Repository<Font>
  ) {
    this.pythonScriptPath = path.join(process.cwd(), 'src', 'stamps', 'python', 'png_stamp_generator.py');
    
    // Ensure the python script exists and is executable
    if (!fs.existsSync(this.pythonScriptPath)) {
      this.logger.error(`Python script not found at path: ${this.pythonScriptPath}`);
      throw new Error('Python stamp generator script not found');
    }
    
    // Make the script executable
    try {
      fs.chmodSync(this.pythonScriptPath, 0o755);
    } catch (error) {
      this.logger.warn(`Could not make Python script executable: ${error.message}`);
    }

    // Ensure output directory exists
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Get font mapping data to pass to Python script
   * Maps font family names to their file paths
   */
  private async getFontMapping(): Promise<Record<string, string>> {
    const fontMapping: Record<string, string> = {};
    
    try {
      const fonts = await this.fontRepository.find({ where: { isActive: true } });
      
      fonts.forEach(font => {
        // Map the font name to its file path
        fontMapping[font.name] = font.filePath;
        
        // Also map without hyphens for compatibility
        if (font.name.includes('-')) {
          const noHyphenName = font.name.replace(/-/g, '');
          fontMapping[noHyphenName] = font.filePath;
        }
        
        // For font families like Montserrat-Bold, add a mapping for just "Montserrat"
        const nameParts = font.name.split('-');
        if (nameParts.length > 1) {
          const familyName = nameParts[0];
          // Only map the base family name to this font if it's not already mapped
          // or if this is a regular/default weight font
          if (!fontMapping[familyName] || 
              font.fontWeight.toLowerCase() === 'regular' || 
              font.fontWeight.toLowerCase() === 'normal') {
            fontMapping[familyName] = font.filePath;
          }
        }
      });
      
      this.logger.log(`Font mapping created with ${Object.keys(fontMapping).length} entries`);
    } catch (error) {
      this.logger.error(`Error creating font mapping: ${error.message}`);
    }
    
    return fontMapping;
  }

  /**
   * Generate a stamp using Python
   * @param template The stamp template data
   * @param textElements Text elements with values
   * @param convertTextToPaths Whether to convert text to paths in PNG
   * @param debug Whether to enable debug mode with reference points
   * @returns Buffer containing the generated stamp image
   */
  async generateStamp({template, textElements, convertTextToPaths = false, debug = false}: {
    template: any;
    textElements: any[];
    convertTextToPaths?: boolean;
    debug?: boolean;
  }): Promise<Buffer> {
    return new Promise(async (resolve, reject) => {
      // Get font mapping to send to Python script
      const fontMapping = await this.getFontMapping();
      
      // Prepare data for Python script
      const inputData = {
        template,
        textElements,
        convertTextToPaths,
        debug,
        fontMapping
      };

      // Spawn Python process
      const pythonProcess = spawn('python3', [this.pythonScriptPath]);
      
      let resultData = '';
      let errorData = '';
      
      // Handle stdout data
      pythonProcess.stdout.on('data', (data) => {
        resultData += data.toString();
      });
      
      // Handle stderr data
      pythonProcess.stderr.on('data', (data) => {
        errorData += data.toString();
        this.logger.debug(`Python stderr: ${data}`);
      });
      
      // Handle process exit
      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`Python process exited with code ${code}: ${errorData}`));
        }
        
        try {
          // Parse the JSON result
          const result = JSON.parse(resultData);
          
          if (!result.success) {
            return reject(new Error(`Python script error: ${result.error}`));
          }
          
          // Convert base64 data to buffer
          const buffer = Buffer.from(result.data, 'base64');
          resolve(buffer);
        } catch (error) {
          reject(new Error(`Failed to parse Python script output: ${error.message}`));
        }
      });
      
      // Handle process error
      pythonProcess.on('error', (error) => {
        reject(new Error(`Failed to start Python process: ${error.message}`));
      });
      
      // Send input data to Python script
      pythonProcess.stdin.write(JSON.stringify(inputData));
      pythonProcess.stdin.end();
    });
  }

  /**
   * Generate and save stamp to file
   * @param template The stamp template data
   * @param textElements Text elements with values
   * @param orderId Order ID for filename
   * @param convertTextToPaths Whether to convert text to paths in PNG
   * @param debug Whether to enable debug mode with reference points
   * @returns Object with path to the saved stamp file and font size adjustments
   */
  async generateAndSaveStamp({template, textElements, orderId, convertTextToPaths = false, debug = false}: {
    template: any,
    textElements: any[],
    orderId: string,
    convertTextToPaths?: boolean;
    debug?: boolean;
  }): Promise<{
    path: string;
    fontSizeAdjustments?: Record<string, FontSizeAdjustment>;
  }> {
    return new Promise(async (resolve, reject) => {
      // Get font mapping to send to Python script
      const fontMapping = await this.getFontMapping();
      
      // Generate unique filename
      const timestamp = Date.now();
      const hash = crypto.createHash('md5').update(`${orderId}-${timestamp}`).digest('hex').substring(0, 8);
      const fileExt = 'png'
      const filename = `${orderId}_${timestamp}_${hash}.${fileExt}`;
      
      // Prepare data for Python script
      const inputData = {
        template,
        textElements,
        convertTextToPaths,
        filename,
        debug,
        fontMapping
      };

      // Spawn Python process
      const pythonProcess = spawn('python3', [this.pythonScriptPath]);
      
      let resultData = '';
      let errorData = '';
      
      // Handle stdout data
      pythonProcess.stdout.on('data', (data) => {
        resultData += data.toString();
      });
      
      // Handle stderr data
      pythonProcess.stderr.on('data', (data) => {
        errorData += data.toString();
        this.logger.debug(`Python stderr: ${data}`);
      });
      
      // Handle process exit
      pythonProcess.on('close', (code) => {
        if (code !== 0) {
          return reject(new Error(`Python process exited with code ${code}: ${errorData}`));
        }
        
        try {
          // Parse the JSON result
          const result = JSON.parse(resultData);
          
          if (!result.success) {
            return reject(new Error(`Python script error: ${result.error}`));
          }
          
          // Get the relative URL path
          const stampImageUrl = `/stamps/${filename}`;
          
          // Get font size adjustments if available
          const fontSizeAdjustments = result.fontSizeAdjustments;
          
          // Log font size adjustments for debugging
          if (fontSizeAdjustments) {
            this.logger.debug(`Received font size adjustments: ${JSON.stringify(fontSizeAdjustments)}`);
          }
          
          resolve({
            path: stampImageUrl,
            fontSizeAdjustments
          });
        } catch (error) {
          reject(new Error(`Failed to parse Python script output: ${error.message}`));
        }
      });
      
      // Handle process error
      pythonProcess.on('error', (error) => {
        reject(new Error(`Failed to start Python process: ${error.message}`));
      });
      
      // Send input data to Python script
      pythonProcess.stdin.write(JSON.stringify(inputData));
      pythonProcess.stdin.end();
    });
  }
} 