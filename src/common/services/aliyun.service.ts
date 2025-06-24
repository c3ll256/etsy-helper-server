import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface AliyunMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface AliyunRequestBody {
  model: string;
  messages: AliyunMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
}

@Injectable()
export class AliyunService {
  private readonly logger = new Logger(AliyunService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly defaultTemperature: number;
  private readonly defaultTopP: number;
  private readonly defaultMaxTokens: number;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('aliyun.apiKey');
    this.baseUrl = this.configService.get<string>('aliyun.baseUrl', 'https://dashscope.aliyuncs.com/compatible-mode/v1');
    this.defaultModel = this.configService.get<string>('aliyun.model', 'qwen-turbo-latest');
    this.defaultTemperature = this.configService.get<number>('aliyun.temperature', 0.7);
    this.defaultTopP = this.configService.get<number>('aliyun.topP', 0.9);
    this.defaultMaxTokens = this.configService.get<number>('aliyun.maxTokens', 2048);
  }

  private async makeRequest(endpoint: string, body: AliyunRequestBody) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        let errorMessage = `Aliyun API error: ${response.status} ${response.statusText}`;
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
      this.logger.error(`Error calling Aliyun API: ${error.message}`);
      throw error;
    }
  }

  async chat(
    messages: AliyunMessage[],
    options: {
      model?: string;
      temperature?: number;
      topP?: number;
      maxTokens?: number;
    } = {},
  ) {
    const requestBody: AliyunRequestBody = {
      model: options.model || this.defaultModel,
      messages,
      temperature: options.temperature || this.defaultTemperature,
      top_p: options.topP || this.defaultTopP,
      max_tokens: options.maxTokens || this.defaultMaxTokens,
    };

    return this.makeRequest('/chat/completions', requestBody);
  }

  async generateText(
    prompt: string,
    options: {
      model?: string;
      temperature?: number;
      topP?: number;
      maxTokens?: number;
      systemPrompt?: string;
    } = {},
  ) {
    const messages: AliyunMessage[] = [];

    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }

    messages.push({ role: 'user', content: prompt });

    return this.chat(messages, options);
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
      systemPrompt?: string;
    } = {},
  ): Promise<any> {
    try {      
      const response = await this.generateText(prompt, options);
      
      if (response && response.choices && response.choices[0] && response.choices[0].message) {
        const content = response.choices[0].message.content;
        // 尝试提取JSON部分
        try {
          // 首先尝试直接解析
          return JSON.parse(content);
        } catch (error) {
          // 如果直接解析失败，尝试提取内容中的```json和```之间的内容
          const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
          if (jsonMatch && jsonMatch[1]) {
            return JSON.parse(jsonMatch[1]);
          }
          // 如果仍然失败，可能需要进一步处理或报错
          throw new Error('Failed to parse JSON from LLM response');
        }
      }
      
      throw new Error('LLM response format is invalid');
    } catch (error) {
      this.logger.error(`Error generating JSON from Aliyun: ${error.message}`);
      throw error;
    }
  }
} 