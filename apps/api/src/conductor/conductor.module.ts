import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ProvidersModule } from '../providers/providers.module';
import { MediaService } from '../media/media.service';
import { Conductor } from './conductor.service';
import { RunAssets } from './run-assets';
import { ToolRegistry } from './tool-registry';

@Module({
  imports: [AiModule, ProvidersModule],
  providers: [Conductor, RunAssets, MediaService, ToolRegistry],
  exports: [Conductor, RunAssets],
})
export class ConductorModule {}
