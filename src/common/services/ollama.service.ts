import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
}

@Injectable()
export class OllamaService {
  private readonly logger = new Logger(OllamaService.name);
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly defaultTemperature: number;
  private readonly defaultTopP: number;
  private readonly defaultMaxTokens: number;

  constructor(private configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('ollama.baseUrl');
    this.defaultModel = this.configService.get<string>('ollama.model');
    this.defaultTemperature = this.configService.get<number>('ollama.temperature');
    this.defaultTopP = this.configService.get<number>('ollama.topP');
    this.defaultMaxTokens = this.configService.get<number>('ollama.maxTokens');
  }

  private async makeRequest(endpoint: string, body: OllamaGenerateRequest) {
    const headers = {
      'Content-Type': 'application/json',
    };

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        let errorMessage = `Ollama API error: ${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          errorMessage += ` - ${JSON.stringify(errorData)}`;
        } catch (e) {
          // If we can't parse the error as JSON, just use the status
        }
        throw new Error(errorMessage);
      }

      return await response.json();
    } catch (error) {
      this.logger.error(`Error calling Ollama API: ${error.message}`);
      throw error;
    }
  }

  async generateText(
    prompt: string,
    options: {
      model?: string;
      temperature?: number;
      topP?: number;
      maxTokens?: number;
    } = {},
  ) {
    const requestBody: OllamaGenerateRequest = {
      stream: false,
      model: options.model || this.defaultModel,
      prompt,
      temperature: options.temperature || this.defaultTemperature,
      top_p: options.topP || this.defaultTopP,
      max_tokens: options.maxTokens || this.defaultMaxTokens,
    };

    const response = await this.makeRequest('/api/generate', requestBody);
    return {
      choices: [
        {
          message: {
            content: response.response || '',
          },
        },
      ],
    };
  }

  /**
   * 生成JSON格式的输出
   * 专门用于解析等需要结构化输出的场景
   * @param prompt 提示词
   * @param options 选项
   * @returns 解析好的JSON对象
   */
  async generateJson(
    prompt: string,
    options: {
      model?: string;
      temperature?: number;
      topP?: number;
      maxTokens?: number;
    } = {},
  ): Promise<any> {
    try {
      // 添加指示Ollama返回JSON格式的指令
      const jsonPrompt = `${prompt}\n\n请确保你的响应是有效的JSON格式，不包含任何前言、解释或结束语。`;
      
      const response = await this.generateText(jsonPrompt, options);
      
      if (response && response.choices && response.choices[0] && response.choices[0].message) {
        const content = response.choices[0].message.content;
        
        // 尝试提取JSON部分
        try {
          // 首先尝试直接解析
          return JSON.parse(content);
        } catch (error) {
          // 如果直接解析失败，尝试提取内容中的JSON部分
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            return JSON.parse(jsonMatch[0]);
          }
          // 如果仍然失败，可能需要进一步处理或报错
          throw new Error('Failed to parse JSON from LLM response');
        }
      }
      
      throw new Error('LLM response format is invalid');
    } catch (error) {
      this.logger.error(`Error generating JSON from Ollama: ${error.message}`);
      throw error;
    }
  }
} 