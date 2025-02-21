import { registerAs } from '@nestjs/config';

export default registerAs('glm', () => ({
  apiKey: process.env.GLM_API_KEY,
  baseUrl: process.env.GLM_API_URL || 'https://open.bigmodel.cn/api/paas/v3',
  model: process.env.GLM_MODEL || 'glm-4',
  temperature: parseFloat(process.env.GLM_TEMPERATURE || '0.7'),
  topP: parseFloat(process.env.GLM_TOP_P || '0.7'),
  maxTokens: parseInt(process.env.GLM_MAX_TOKENS || '2048', 10),
})); 