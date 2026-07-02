import { Module, forwardRef } from '@nestjs/common';
import { InstagramService } from './instagram.service';
import { InstagramDmService } from './instagram-dm.service';
import { DatabaseModule } from '../database/database.module';
import { TelegramModule } from '../telegram/telegram.module';

@Module({
  imports: [
    DatabaseModule,
    forwardRef(() => TelegramModule),
  ],
  providers: [InstagramService, InstagramDmService],
  exports: [InstagramService, InstagramDmService],
})
export class InstagramModule {}
