import { spawn } from 'child_process';
import * as path from 'path';

export interface PythonRunnerOptions {
  pythonExecutable: string;
  scriptPath?: string;
  cwd?: string;
}

/** 调用 basket_order_generator.py（v2 请求），返回解析后的 JSON 结果 */
export function runPythonGenerator(request: any, options: PythonRunnerOptions): Promise<any> {
  const cwd = options.cwd || process.cwd();
  const scriptPath = options.scriptPath || path.join(cwd, 'src', 'basket', 'python', 'basket_order_generator.py');
  return new Promise((resolve, reject) => {
    const proc = spawn(options.pythonExecutable, [scriptPath], { cwd });
    const out: Buffer[] = [];
    let err = '';
    proc.stdout.on('data', (d) => out.push(d));
    proc.stderr.on('data', (d) => {
      err += d.toString();
      if (err.length > 20000) err = err.slice(-20000);
    });
    proc.on('error', (e) => reject(new Error(`无法启动 Python：${e.message}`)));
    proc.on('close', (code) => {
      const text = Buffer.concat(out).toString('utf8').trim();
      if (code !== 0) return reject(new Error(`Python 退出码 ${code}：${err.slice(-2000)}`));
      try {
        const lastLine = text.split('\n').pop() || '';
        resolve(JSON.parse(lastLine));
      } catch (e) {
        reject(new Error(`无法解析 Python 输出：${(e as Error).message}；stderr: ${err.slice(-1000)}`));
      }
    });
    const payload = JSON.stringify({ orderData: Buffer.from(JSON.stringify(request)).toString('base64') });
    proc.stdin.write(payload);
    proc.stdin.end();
  });
}
