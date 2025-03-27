import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference'
import * as express from 'express';
import { UsersService } from './users/users.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe());

  // Configure CORS
  app.enableCors();

  const config = new DocumentBuilder()
    .setTitle('Etsy Helper API')
    .setDescription('The Etsy Helper API description')
    .setVersion('1.0')
    .addBearerAuth()
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
  app.use('/uploads', express.static('uploads'));
  app.use('/baskets', express.static('uploads/baskets'));

  // Create admin user if not exists
  const usersService = app.get(UsersService);
  await usersService.createAdminUserIfNotExists();

  await app.listen(process.env.PORT || 3080);
}
bootstrap(); 