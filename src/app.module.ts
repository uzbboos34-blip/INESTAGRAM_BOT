import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TelegramModule } from './telegram/telegram.module';
import { InstagramModule } from './instagram/instagram.module';
import { DatabaseModule } from './database/database.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DatabaseModule,
    TelegramModule,
    InstagramModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
