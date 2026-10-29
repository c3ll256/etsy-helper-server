import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface FontFaceInfo {
  family: string | null;
  subfamily: string | null;
  fullName: string | null;
  glyphCount: number;
  cjkCount: number;
  isCFF: boolean;
  index?: number;
  path?: string;
  filename?: string;
  isCollection?: boolean;
}

/** 调用 python fontTools 拆分字体集合、读取字体信息 */
@Injectable()
export class FontToolsService {
  private readonly logger = new Logger(FontToolsService.name);
  private readonly scriptPath = this.resolveScriptPath();

  private resolveScriptPath(): string {
    const candidates = [
      path.join(process.cwd(), 'src', 'fonts', 'python', 'font_tools.py'),
      path.join(__dirname, 'python', 'font_tools.py'),
    ];
    return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
  }

  private pythonExecutable(): string {
    return process.env.PYTHON_EXECUTABLE?.trim() || 'python3';
  }

  private run(args: string[]): Promise<any> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonExecutable(), [this.scriptPath, ...args]);
      let out = '';
      let err = '';
      child.stdout.on('data', data => (out += data));
      child.stderr.on('data', data => (err += data));
      child.on('error', error => reject(error));
      child.on('close', code => {
        try {
          const result = JSON.parse(out.trim().split('\n').pop() || '{}');
          if (!result.success) return reject(new Error(result.error || err || `exit ${code}`));
          resolve(result);
        } catch {
          reject(new Error(err || out || `font tools exited with ${code}`));
        }
      });
    });
  }

  async splitCollection(filePath: string, outDir: string, prefix: string): Promise<FontFaceInfo[]> {
    const result = await this.run(['split', filePath, outDir, prefix]);
    return result.fonts;
  }

  async inspect(filePath: string): Promise<FontFaceInfo> {
    const result = await this.run(['inspect', filePath]);
    return result.font;
  }
}
