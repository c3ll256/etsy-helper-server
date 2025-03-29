import { registerAs } from '@nestjs/config';

export default registerAs('aliyun', () => ({
  apiKey: process.env.ALIYUN_API_KEY,
  baseUrl: process.env.ALIYUN_API_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: process.env.ALIYUN_MODEL || 'qwen-turbo',
  temperature: parseFloat(process.env.ALIYUN_TEMPERATURE || '0.7'),
  topP: parseFloat(process.env.ALIYUN_TOP_P || '0.7'),
  maxTokens: parseInt(process.env.ALIYUN_MAX_TOKENS || '2048', 10),
})); 