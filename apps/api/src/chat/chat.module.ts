import { Module } from '@nestjs/common';
import { ConductorModule } from '../conductor/conductor.module';
import { ChatController } from './chat.controller';
import { ProvidersModule } from '../providers/providers.module';

@Module({ imports: [ConductorModule, ProvidersModule], controllers: [ChatController] })
export class ChatModule {}
