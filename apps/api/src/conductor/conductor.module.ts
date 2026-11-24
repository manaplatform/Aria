import { WebModule } from '../web/web.module';
import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ProvidersModule } from '../providers/providers.module';
import { MediaService } from '../media/media.service';
import { Conductor } from './conductor.service';
import { ConductorLoopExecutor } from './loop-executor';
import { RunAssets } from './run-assets';
import { CapabilityHost } from './capability-host';
import { ToolRegistry } from './tool-registry';

@Module({
  imports: [AiModule, ProvidersModule, WebModule],
  providers: [Conductor, ConductorLoopExecutor, RunAssets, MediaService, ToolRegistry, CapabilityHost],
  exports: [Conductor, RunAssets, ToolRegistry, CapabilityHost],
})
export class ConductorModule {}
