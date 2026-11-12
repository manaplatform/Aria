import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ChatModule } from './chat/chat.module';

@Module({
  imports: [ChatModule],
  controllers: [HealthController],
})
export class AppModule {}
