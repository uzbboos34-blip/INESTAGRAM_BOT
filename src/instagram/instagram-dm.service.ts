import { Injectable, Inject, forwardRef, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IgApiClient } from 'instagram-private-api';
import { DatabaseService } from '../database/database.service';
import { TelegramService } from '../telegram/telegram.service';

@Injectable()
export class InstagramDmService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InstagramDmService.name);
  private ig: IgApiClient;
  private isLoggedIn = false;
  private pollInterval: NodeJS.Timeout | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    @Inject(forwardRef(() => TelegramService))
    private readonly telegramService: TelegramService,
  ) {}

  async onModuleInit() {
    const username = this.configService.get<string>('INSTAGRAM_BOT_USERNAME');
    const password = this.configService.get<string>('INSTAGRAM_BOT_PASSWORD');

    if (!username || !password || username.includes('YOUR_INSTAGRAM_BOT')) {
      this.logger.warn('INSTAGRAM_BOT_USERNAME or INSTAGRAM_BOT_PASSWORD is not set. Instagram DM Service will not start.');
      return;
    }

    this.ig = new IgApiClient();
    this.ig.state.generateDevice(username);

    // Attach Bot Specific Proxy if defined in .env, fallback to first proxy from PROXY_POOL
    let botProxy = this.configService.get<string>('INSTAGRAM_BOT_PROXY');
    if (!botProxy) {
      const envPool = this.configService.get<string>('PROXY_POOL');
      if (envPool) {
        const proxies = envPool.split(',').map(item => item.trim()).filter(Boolean);
        if (proxies.length > 0) {
          const firstProxy = proxies[0];
          botProxy = firstProxy.startsWith('http') ? firstProxy : `http://${firstProxy}`;
          this.logger.log(`INSTAGRAM_BOT_PROXY not set. Falling back to first proxy from PROXY_POOL: ${botProxy.split('@')[1] || botProxy}`);
        }
      }
    }

    if (botProxy) {
      this.logger.log(`Using proxy for Instagram Bot client: ${botProxy.split('@')[1] || botProxy}`);
      this.ig.state.proxyUrl = botProxy;
    }

    try {
      // 1. Try to load saved session from database to avoid fresh logins and blocks
      const savedSession = await this.databaseService.getSession();
      if (savedSession) {
        this.logger.log('Restoring Instagram session from database SQLite...');
        try {
          // Parse stringified session state and deserialize
          await this.ig.state.deserialize(JSON.parse(savedSession));
          const currentUser = await this.ig.account.currentUser();
          this.logger.log(`Successfully recovered session. Logged in as: @${currentUser.username}`);
          this.isLoggedIn = true;
        } catch (sessionErr: any) {
          this.logger.warn(`Saved session could not be recovered: ${sessionErr.message}. Falling back to fresh login.`);
        }
      }

      // 2. Perform fresh login if session couldn't be recovered
      if (!this.isLoggedIn) {
        this.logger.log(`Attempting fresh Instagram login for @${username}...`);
        await this.ig.simulate.preLoginFlow();
        const loggedInUser = await this.ig.account.login(username, password);
        this.logger.log(`Fresh login successful! Logged in as: @${loggedInUser.username}`);
        this.isLoggedIn = true;

        // Post login simulation
        process.nextTick(async () => {
          try {
            await this.ig.simulate.postLoginFlow();
          } catch (e) {}
        });

        // Save serialized session state back to database
        const serialized = await this.ig.state.serialize();
        await this.databaseService.saveSession(JSON.stringify(serialized));
        this.logger.log('Successfully saved session state to database SQLite.');
      }

      // 3. Start Polling DMs
      this.startPolling();

    } catch (err: any) {
      this.logger.error(`Failed to initialize Instagram DM Client: ${err.message}`);
    }
  }

  onModuleDestroy() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.logger.log('Instagram DM polling stopped.');
    }
  }

  private startPolling() {
    // 30 seconds interval to mimic human-like speed and bypass rate-limiting blocks
    const intervalMs = 30000;
    this.pollInterval = setInterval(async () => {
      if (!this.isLoggedIn) return;
      try {
        await this.pollDirectInbox();
      } catch (err: any) {
        this.logger.warn(`Error during Instagram DM polling: ${err.message}`);
        // Handle session validation failures (401, Login Required, etc.)
        if (err.message?.includes('login_required') || err.message?.includes('401')) {
          this.logger.warn('Session has expired. Resetting login flag for re-auth on next cycle.');
          this.isLoggedIn = false;
        }
      }
    }, intervalMs);
    this.logger.log(`Instagram DM polling initiated successfully (interval: ${intervalMs / 1000}s)`);
  }

  private async pollDirectInbox() {
    const inboxFeed = this.ig.feed.directInbox();
    const threads = await inboxFeed.items();

    for (const thread of threads) {
      const threadId = thread.thread_id;
      // Get participant (usually index 0 since we are in 1-on-1 DM)
      const otherUser = thread.users?.[0];
      if (!otherUser) continue;

      const username = otherUser.username.toLowerCase();
      const items = thread.items || [];

      for (const item of items) {
        const messageId = item.item_id;

        // Ignore messages sent by the bot account itself
        if (String(item.user_id) === String(this.ig.state.cookieUserId)) {
          continue;
        }

        // Deduplicate: check if this message was already processed
        const isProcessed = await this.databaseService.isMessageProcessed(messageId);
        if (isProcessed) {
          continue;
        }

        try {
          // Process message
          await this.handleInboxMessage(threadId, username, item);
          // Mark processed in DB to prevent duplicates
          await this.databaseService.markMessageAsProcessed(messageId);
        } catch (err: any) {
          this.logger.error(`Error processing message ${messageId} from @${username}: ${err.message}`);
        }
      }
    }
  }

  private async handleInboxMessage(threadId: string, username: string, item: any) {
    this.logger.log(`Received message from @${username} (type: ${item.item_type})`);

    // --- CASE 1: Text message containing Verification Code ---
    if (item.item_type === 'text') {
      const text = item.text.trim();
      // Match exactly a 4-digit code (e.g. 1948)
      if (/^\d{4}$/.test(text)) {
        const mapping = await this.databaseService.getMappingByCode(text);
        if (mapping && mapping.instagram_username.toLowerCase() === username) {
          // Update mapping is_verified = 1 in database
          await this.databaseService.verifyMapping(username);

          // Notify user via Telegram Bot
          await this.telegramService.sendDirectMessage(
            mapping.telegram_chat_id,
            `✅ *Instagram akkauntingiz muvaffaqiyatli bog'landi!*\n\n` +
            `Endi Instagram'da *@${username}* profilingizdan bizning bot akkauntimiz Direct (DM)iga yuborgan barcha Reels/videolaringiz avtomatik ravishda shu yerga yuklab yuboriladi.`,
            { parse_mode: 'Markdown' }
          );

          // Send confirmation text back in Instagram DM
          await this.ig.entity.directThread(threadId).broadcastText(
            `Tasdiqlandi! ✅ Akkauntingiz Telegram botga muvaffaqiyatli bog'landi. Endi bemalol video share qilishingiz mumkin.`
          );
        } else {
          // Mismatch or expired code
          await this.ig.entity.directThread(threadId).broadcastText(
            `Tasdiqlash kodi topilmadi yoki xato. Iltimos, Telegram botdan kodni tekshiring. ❌`
          );
        }
      }
    }
    // --- CASE 2: Shared Reel or Post (clip or media_share) ---
    else if (item.item_type === 'clip' || item.item_type === 'media_share') {
      // Check if user has verified status
      const mapping = await this.databaseService.getMappingByUsername(username);
      if (mapping && mapping.is_verified === 1) {
        let shortcode = '';
        if (item.item_type === 'clip' && item.clip?.code) {
          shortcode = item.clip.code;
        } else if (item.item_type === 'media_share' && item.media_share?.code) {
          shortcode = item.media_share.code;
        }

        if (shortcode) {
          this.logger.log(`Shared Reel/Post detected from verified user @${username}: shortcode ${shortcode}`);
          
          // Send acknowledgement message in Instagram DM
          await this.ig.entity.directThread(threadId).broadcastText(
            `Videongiz qabul qilindi. Telegram'ga yuborilmoqda... ⏳`
          );

          // Call the delivery pipeline
          await this.telegramService.deliverSharedMedia(mapping.telegram_chat_id, shortcode, username);
        }
      } else {
        // User not verified - prompt them with instructions in Instagram DM
        await this.ig.entity.directThread(threadId).broadcastText(
          `Salom! 📥 Ushbu videoni Telegram botingizga yuklash uchun avval akkauntingizni bog'lashingiz kerak.\n\n` +
          `Buning uchun:\n` +
          `1️⃣ Telegram botimizga kiring.\n` +
          `2️⃣ /link @${username} buyrug'ini yuboring.\n` +
          `3️⃣ Bot bergan 4-xonali tasdiqlash kodini bu yerga (Direct'ga) yozib yuboring.`
        );
      }
    }
  }
}
