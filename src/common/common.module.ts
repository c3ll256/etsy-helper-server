import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GlmService } from './services/glm.service';
import { OllamaService } from './services/ollama.service';
import glmConfig from '../config/glm.config';
import ollamaConfig from '../config/ollama.config';
import { AliyunService } from './services/aliyun.service';
import aliyunConfig from 'src/config/aliyun.config';
import { JobQueueService } from './services/job-queue.service';

@Module({
  imports: [
    ConfigModule.forFeature(glmConfig),
    ConfigModule.forFeature(ollamaConfig),
    ConfigModule.forFeature(aliyunConfig)
  ],
  providers: [GlmService, OllamaService, AliyunService, JobQueueService],
  exports: [GlmService, OllamaService, AliyunService, JobQueueService],
})
export class CommonModule {} 