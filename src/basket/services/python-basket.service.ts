import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

@Injectable()
export class PythonBasketService {
  private readonly logger = new Logger(PythonBasketService.name);
  private readonly pythonScriptPath: string;
  private readonly outputDir = 'uploads/baskets';

  constructor() {
    this.pythonScriptPath = path.join(process.cwd(), 'src', 'basket', 'python', 'basket_order_generator.py');
    
    // Ensure the python script exists and is executable
    if (!fs.existsSync(this.pythonScriptPath)) {
      this.logger.error(`Python script not found at path: ${this.pythonScriptPath}`);
      throw new Error('Python basket order generator script not found');
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
   * Generate PPT for basket orders using the Python script
   * @param jsonData Base64 encoded JSON data with processed order information
   * @returns Object containing generation results
   */
  async generateBasketOrderPPT(jsonData: string): Promise<any> {
    return new Promise((resolve, reject) => {
      // Generate unique filename
      const timestamp = Date.now();
      const hash = crypto.createHash('md5').update(`${timestamp}`).digest('hex').substring(0, 8);
      const filename = `basket_orders_${timestamp}_${hash}.pptx`;
      const outputPath = path.join(this.outputDir, filename);
      
      // Prepare data for Python script
      const inputData = {
        excelData: jsonData, // We keep the parameter name for backward compatibility
        outputPath,
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
            return reject(new Error(`Python script error: ${result.message || 'Unknown error'}`));
          }
          
          // Check if the data is available
          if (!result.data) {
            return reject(new Error('No PPT data returned from Python script'));
          }
          
          // Write the PPT data to a file
          const pptBuffer = Buffer.from(result.data, 'base64');
          fs.writeFileSync(outputPath, pptBuffer);
          
          // Return the result with the file path
          resolve({
            ...result,
            filePath: `/uploads/baskets/${filename}`,
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