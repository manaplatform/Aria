import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module';
import { ChatController } from './chat.controller';
import { ProvidersModule } from '../providers/providers.module';

@Module({ imports: [AiModule, ProvidersModule], controllers: [ChatController] })
export class ChatModule {}
