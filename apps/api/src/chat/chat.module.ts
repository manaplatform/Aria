import { Module } from '@nestjs/common';
import { ConductorModule } from '../conductor/conductor.module';
import { ChatController } from './chat.controller';
import { WebModule } from '../web/web.module';
import { ProvidersModule } from '../providers/providers.module';

@Module({ imports: [ConductorModule, ProvidersModule, WebModule], controllers: [ChatController] })
export class ChatModule {}
