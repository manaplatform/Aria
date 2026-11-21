import { WebModule } from './web/web.module';
import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ChatModule } from './chat/chat.module';
import { ProvidersModule } from './providers/providers.module';
import { ConductorModule } from './conductor/conductor.module';
import { VoiceService } from './voice/voice.service';

@Module({
  imports: [ChatModule, ProvidersModule, ConductorModule, WebModule],
  controllers: [HealthController],
  providers: [VoiceService],
})
export class AppModule {}
