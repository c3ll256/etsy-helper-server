import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference'
import * as express from 'express';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe());

  const config = new DocumentBuilder()
    .setTitle('Etsy Helper API')
    .setDescription('The Etsy Helper API description')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  // SwaggerModule.setup('docs', app, document);

  app.use(
    '/docs',
    apiReference({
      spec: {
        content: document,
      },
    }),
  )

  // 配置静态文件服务
  app.use('/stamps', express.static('uploads/stamps'));

  await app.listen(process.env.PORT || 3000);
}
bootstrap(); 