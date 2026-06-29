import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramService } from './telegram.service';
import { InstagramModule } from '../instagram/instagram.module';

@Module({
  imports: [ConfigModule, InstagramModule],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
