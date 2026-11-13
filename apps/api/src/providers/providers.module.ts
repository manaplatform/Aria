import { Module } from '@nestjs/common';
import { ProvidersService } from './providers.service';
import { ModelRegistry } from './model-registry.service';
import { AiModule } from '../ai/ai.module';
import { ProvidersController } from './providers.controller';
@Module({
  imports: [AiModule],
  providers: [ProvidersService, ModelRegistry],
  controllers: [ProvidersController],
  exports: [ProvidersService, ModelRegistry],
})
export class ProvidersModule {}
