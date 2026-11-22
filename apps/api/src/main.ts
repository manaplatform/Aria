import { config } from 'dotenv';
import path from 'node:path';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { BrowserPortClient, type BrowserPort } from './web/browser-port.client';
import { WebService } from './web/web.service';
import { AppModule } from './app.module';
import { CapabilityHost } from './conductor/capability-host';
import { ModelRegistry } from './providers/model-registry.service';

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
          on(
            name: string,
            callback: (event: { data: unknown; ports?: BrowserPort[] }) => void,
          ): void;
        };
      }
    ).parentPort;
    if (managed) {
      if (!parentPort) throw new Error('The managed API requires its desktop parent.');
      parentPort.postMessage({ type: 'configure' });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Configuration timed out.')), 10_000);
        parentPort.on('message', ({ data, ports }) => {
          if (!data || typeof data !== 'object' || !('registry' in data)) return;
          clearTimeout(timeout);
          try {
            app.get(ModelRegistry).install(data.registry);
            if ('web' in data) app.get(WebService).install(data.web);
            if (
              ports?.length &&
              'browserGeneration' in data &&
              typeof data.browserGeneration === 'string'
            )
              app.get(BrowserPortClient).install(ports[0], data.browserGeneration);
            if ('tools' in data) {
              const index =
                'browserGeneration' in data && typeof data.browserGeneration === 'string' ? 1 : 0;
              const port = ports?.[index];
              if (!port) throw new Error('Missing desktop capability port.');
              app.get(CapabilityHost).install(data.tools, port);
            }
            resolve();
          } catch {
            reject(new Error('Invalid registry configuration.'));
          }
        });
      });
    }
    parentPort?.postMessage({ type: 'ready', port });
    parentPort?.on('message', (event) => {
      if (event.data === 'shutdown') void app.close().then(() => process.exit(0));
    });
  })().catch(() => {
    console.error('Aria API could not start.');
    process.exitCode = 1;
  });
}
