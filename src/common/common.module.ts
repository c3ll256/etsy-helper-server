import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GlmService } from './services/glm.service';
import { OllamaService } from './services/ollama.service';
import glmConfig from '../config/glm.config';
import ollamaConfig from '../config/ollama.config';

@Module({
  imports: [
    ConfigModule.forFeature(glmConfig),
    ConfigModule.forFeature(ollamaConfig),
  ],
  providers: [GlmService, OllamaService],
  exports: [GlmService, OllamaService],
})
export class CommonModule {} 