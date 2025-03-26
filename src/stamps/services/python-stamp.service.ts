import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

@Injectable()
export class PythonStampService {
  private readonly logger = new Logger(PythonStampService.name);
  private readonly pythonScriptPath: string;
  private readonly outputDir = 'uploads/stamps';

  constructor() {
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
    return new Promise((resolve, reject) => {
      // Prepare data for Python script
      const inputData = {
        template,
        textElements,
        convertTextToPaths,
        debug
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
        this.logger.error(`Python stderr: ${data}`);
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
   * @returns Path to the saved stamp file
   */
  async generateAndSaveStamp({template, textElements, orderId, convertTextToPaths = false, debug = false}: {
    template: any,
    textElements: any[],
    orderId: string,
    convertTextToPaths?: boolean;
    debug?: boolean;
  }): Promise<string> {
    return new Promise((resolve, reject) => {
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
        debug
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
        this.logger.error(`Python stderr: ${data}`);
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
          resolve(stampImageUrl);
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