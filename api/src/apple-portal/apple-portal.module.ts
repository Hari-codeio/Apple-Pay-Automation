import { Module } from '@nestjs/common';
import { ApplePortalClient } from './apple-portal.client';
import { AppleSessionStore } from './apple-session.store';
import { BrowserFactory } from './browser.factory';

@Module({
  providers: [AppleSessionStore, BrowserFactory, ApplePortalClient],
  exports: [ApplePortalClient, AppleSessionStore, BrowserFactory],
})
export class ApplePortalModule {}
