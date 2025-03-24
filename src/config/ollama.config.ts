import { registerAs } from '@nestjs/config';

export default registerAs('ollama', () => ({
  baseUrl: process.env.OLLAMA_API_URL || 'http://localhost:11434',
  model: process.env.OLLAMA_MODEL || 'qwen2.5:7b',
  temperature: parseFloat(process.env.OLLAMA_TEMPERATURE || '0.7'),
  topP: parseFloat(process.env.OLLAMA_TOP_P || '0.7'),
  maxTokens: parseInt(process.env.OLLAMA_MAX_TOKENS || '2048', 10),
})); 