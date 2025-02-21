import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GlmService } from './services/glm.service';
import glmConfig from '../config/glm.config';

@Module({
  imports: [
    ConfigModule.forFeature(glmConfig),
  ],
  providers: [GlmService],
  exports: [GlmService],
})
export class CommonModule {} 