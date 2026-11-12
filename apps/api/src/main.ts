import { config } from 'dotenv';
import path from 'node:path';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

if (process.env.ARIA_MANAGED !== '1')
  config({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(__dirname, '../../..', '.env') });

export async function createApi() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: process.env.NODE_ENV === 'test' ? false : ['error', 'warn'],
  });
  app.useBodyParser('json', { limit: '512kb' });
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  );
  app.enableShutdownHooks();
  return app;
}

if (require.main === module) {
  void (async () => {
    const app = await createApi();
    const managed = process.env.ARIA_MANAGED === '1';
    await app.listen(managed ? 0 : Number(process.env.PORT) || 3000, '127.0.0.1');
    const port = (app.getHttpServer().address() as { port: number }).port;
    const parentPort = (
      process as NodeJS.Process & {
        parentPort?: {
          postMessage(message: unknown): void;
          on(name: string, callback: (event: { data: unknown }) => void): void;
        };
      }
    ).parentPort;
    parentPort?.postMessage({ type: 'ready', port });
    parentPort?.on('message', (event) => {
      if (event.data === 'shutdown') void app.close().then(() => process.exit(0));
    });
  })().catch(() => {
    console.error('Aria API could not start.');
    process.exitCode = 1;
  });
}
