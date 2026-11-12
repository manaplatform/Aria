import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ChatModule } from './chat/chat.module';
import { ProvidersModule } from './providers/providers.module';
import { MediaController } from './media/media.controller';
import { MediaService } from './media/media.service';
import { VoiceService } from './voice/voice.service';

@Module({
  imports: [ChatModule, ProvidersModule],
  controllers: [HealthController, MediaController],
  providers: [MediaService, VoiceService],
})
export class AppModule {}
