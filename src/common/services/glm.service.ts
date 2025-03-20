import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

interface GlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface GlmRequestBody {
  model: string;
  messages: GlmMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stream?: boolean;
}

@Injectable()
export class GlmService {
  private readonly logger = new Logger(GlmService.name);
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;
  private readonly defaultTemperature: number;
  private readonly defaultTopP: number;
  private readonly defaultMaxTokens: number;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('glm.apiKey');
    this.baseUrl = this.configService.get<string>('glm.baseUrl');
    this.defaultModel = this.configService.get<string>('glm.model');
    this.defaultTemperature = this.configService.get<number>('glm.temperature');
    this.defaultTopP = this.configService.get<number>('glm.topP');
    this.defaultMaxTokens = this.configService.get<number>('glm.maxTokens');
  }

  private generateSignature(timestamp: number): string {
    const apiKey = this.apiKey;
    if (!apiKey) {
      throw new Error('GLM API key is not configured');
    }

    const [id, secret] = apiKey.split('.');
    const signature = crypto
      .createHmac('sha256', secret)
      .update(id + timestamp.toString())
      .digest('hex');

    return signature;
  }

  private async makeRequest(endpoint: string, body: GlmRequestBody) {
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
        const errorData = await response.json();
        throw new Error(`GLM API error: ${JSON.stringify(errorData)}`);
      }

      return await response.json();
    } catch (error) {
      this.logger.error(`Error calling GLM API: ${error.message}`);
      throw error;
    }
  }

  async chat(
    messages: GlmMessage[],
    options: {
      model?: string;
      temperature?: number;
      topP?: number;
      maxTokens?: number;
    } = {},
  ) {
    const requestBody: GlmRequestBody = {
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
    } = {},
  ) {
    return this.chat(
      [{ role: 'user', content: prompt }],
      options,
    );
  }
} 