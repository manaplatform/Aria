import { Module } from '@nestjs/common';
import { BrowserPortClient } from './browser-port.client';
import { WebService } from './web.service';

@Module({ providers: [WebService, BrowserPortClient], exports: [WebService, BrowserPortClient] })
export class WebModule {}
