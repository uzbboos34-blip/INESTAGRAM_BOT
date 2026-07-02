import { Injectable, Inject, forwardRef, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseService } from '../database/database.service';
import { TelegramService } from '../telegram/telegram.service';
import axios, { AxiosInstance } from 'axios';
import { randomUUID } from 'crypto';

@Injectable()
export class InstagramDmService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InstagramDmService.name);
  private pollInterval: NodeJS.Timeout | null = null;
  private cookieString: string = '';
  private csrfToken: string = '';
  private dsUserId: string = '';
  private httpClient: AxiosInstance;

  constructor(
    private readonly configService: ConfigService,
    private readonly databaseService: DatabaseService,
    @Inject(forwardRef(() => TelegramService))
    private readonly telegramService: TelegramService,
  ) {}

  async onModuleInit() {
    const botCookie = this.configService.get<string>('INSTAGRAM_BOT_COOKIE');
    if (!botCookie) {
      this.logger.warn('INSTAGRAM_BOT_COOKIE is not set. Instagram DM Service will not start.');
      return;
    }

    this.cookieString = botCookie;

    // Parse key values from cookie string
    this.csrfToken = this.parseCookieValue(botCookie, 'csrftoken');
    this.dsUserId = this.parseCookieValue(botCookie, 'ds_user_id');

    if (!this.csrfToken || !this.dsUserId) {
      this.logger.warn('Could not parse csrftoken or ds_user_id from INSTAGRAM_BOT_COOKIE. Service will not start.');
      return;
    }

    this.logger.log(`Loaded bot cookie for user ID: ${this.dsUserId}`);

    // Build axios client targeting www.instagram.com web API
    // Browser sessions (web cookies) work with www.instagram.com but NOT with i.instagram.com
    this.httpClient = axios.create({
      baseURL: 'https://www.instagram.com',
      headers: {
        'Cookie': this.cookieString,
        'X-CSRFToken': this.csrfToken,
        'X-IG-App-ID': '936619743392459',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Referer': 'https://www.instagram.com/direct/inbox/',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Origin': 'https://www.instagram.com',
      },
    });

    // Verify the session by making a test request
    try {
      this.logger.log('Verifying Instagram web session...');
      const testResp = await this.httpClient.get('/api/v1/accounts/current_user/', {
        params: { edit: true },
      });
      const username = testResp.data?.user?.username;
      this.logger.log(`Instagram web session verified! Logged in as: @${username}`);
    } catch (err: any) {
      this.logger.warn(`Session verification failed: ${err.message}. Polling will start anyway.`);
    }

    this.startPolling();
  }

  onModuleDestroy() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      this.logger.log('Instagram DM polling stopped.');
    }
  }

  private parseCookieValue(cookieString: string, key: string): string {
    const match = cookieString.match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : '';
  }

  // Get Instagram user's numeric ID from their username
  async getUserIdByUsername(username: string): Promise<string | null> {
    try {
      const resp = await this.httpClient.get('/web/search/topsearch/', {
        params: { context: 'blended', query: username },
      });
      const users = resp.data?.users || [];
      const match = users.find((u: any) => u.user?.username?.toLowerCase() === username.toLowerCase());
      const userId = match?.user?.pk;
      return userId ? String(userId) : null;
    } catch (err: any) {
      this.logger.warn(`Could not get Instagram user ID for @${username} via topsearch: ${err.message}`);
      return null;
    }
  }

  // Send a DM to any Instagram user by their numeric user ID (creates new thread)
  async sendDmToNewUser(instagramUserId: string, text: string): Promise<boolean> {
    try {
      const clientContext = randomUUID().replace(/-/g, '');
      const params = new URLSearchParams({
        recipient_users: `[[${instagramUserId}]]`,
        text,
        client_context: clientContext,
        mutation_token: clientContext,
      });
      await this.httpClient.post(
        '/api/v1/direct_v2/threads/broadcast/text/',
        params.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      this.logger.log(`Sent DM to Instagram user ID ${instagramUserId}`);
      return true;
    } catch (err: any) {
      this.logger.warn(`Failed to send DM to user ${instagramUserId}: ${err.response?.status} ${err.message}`);
      return false;
    }
  }

  private startPolling() {
    const intervalMs = 30000; // Set to 30 seconds as requested
    this.pollInterval = setInterval(async () => {
      try {
        await this.pollDirectInbox();
      } catch (err: any) {
        const status = err.response?.status;
        this.logger.warn(`Error during Instagram DM polling: ${status || ''} ${err.message}`);
        
        // If session is expired, blocked, or invalid (400, 401, 403), stop polling to prevent account damage
        if (status === 400 || status === 401 || status === 403) {
          this.logger.error('Instagram session is invalid, expired or blocked. Stopping DM polling. Please update INSTAGRAM_BOT_COOKIE.');
          if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
          }
        }
      }
    }, intervalMs);
    this.logger.log(`Instagram DM polling initiated successfully (interval: ${intervalMs / 1000}s)`);
  }

  private async pollDirectInbox() {
    const resp = await this.httpClient.get('/api/v1/direct_v2/inbox/', {
      params: {
        visual_message_return_type: 'unseen',
        thread_message_limit: '10',
        persistentBadging: 'true',
        limit: '20',
      },
    });

    const threads: any[] = resp.data?.inbox?.threads || [];

    for (const thread of threads) {
      const threadId: string = thread.thread_id;
      const otherUser = thread.users?.[0];
      if (!otherUser) continue;

      const username: string = (otherUser.username || '').toLowerCase();
      const items: any[] = thread.items || [];

      for (const item of items) {
        const messageId: string = item.item_id;

        // Ignore messages sent by the bot account itself
        if (String(item.user_id) === String(this.dsUserId)) {
          continue;
        }

        // Deduplicate: check if this message was already processed
        const isProcessed = await this.databaseService.isMessageProcessed(messageId);
        if (isProcessed) continue;

        try {
          await this.handleInboxMessage(threadId, username, item);
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
      const text = (item.text || '').trim();
      if (/^\d{4}$/.test(text)) {
        const mapping = await this.databaseService.getMappingByCode(text);
        if (mapping && mapping.instagram_username.toLowerCase() === username) {
          await this.databaseService.verifyMapping(username);

          await this.telegramService.sendDirectMessage(
            mapping.telegram_chat_id,
            `✅ *Instagram akkauntingiz muvaffaqiyatli bog'landi!*\n\n` +
            `Endi Instagram'da *@${username}* profilingizdan bizning bot akkauntimiz Direct (DM)iga yuborgan barcha Reels/videolaringiz avtomatik ravishda shu yerga yuklab yuboriladi.`,
            { parse_mode: 'Markdown' }
          );

          await this.sendInstagramMessage(threadId,
            `Tasdiqlandi! ✅ Akkauntingiz Telegram botga muvaffaqiyatli bog'landi. Endi bemalol video share qilishingiz mumkin.`
          );
        } else {
          await this.sendInstagramMessage(threadId,
            `Tasdiqlash kodi topilmadi yoki xato. Iltimos, Telegram botdan kodni tekshiring. ❌`
          );
        }
      }
    }
    // --- CASE 2: Shared Reel or Post (clip or media_share) ---
    else if (item.item_type === 'clip' || item.item_type === 'media_share') {
      const mapping = await this.databaseService.getMappingByUsername(username);
      if (mapping && mapping.is_verified === 1) {
        // Log full item to understand web API structure
        this.logger.log(`Clip/media item keys: ${JSON.stringify(Object.keys(item))}`);
        if (item.clip) this.logger.log(`clip keys: ${JSON.stringify(Object.keys(item.clip))}`);
        if (item.media_share) this.logger.log(`media_share keys: ${JSON.stringify(Object.keys(item.media_share))}`);

        // Try all possible shortcode/code paths (mobile API vs web API differ)
        let shortcode =
          item.clip?.code ||
          item.clip?.shortcode ||
          item.clip?.media?.code ||
          item.clip?.media?.shortcode ||
          item.clip?.clip?.code ||
          item.clip?.clip?.shortcode ||
          item.media_share?.code ||
          item.media_share?.shortcode ||
          item.media_share?.media?.code ||
          item.media_share?.media?.shortcode ||
          '';

        if (shortcode) {
          this.logger.log(`Shared Reel/Post detected from verified user @${username}: shortcode ${shortcode}`);

          await this.sendInstagramMessage(threadId,
            `Videongiz qabul qilindi. Telegram'ga yuborilmoqda... ⏳`
          );

          await this.telegramService.deliverSharedMedia(mapping.telegram_chat_id, shortcode, username);
        } else {
          this.logger.warn(`Could not extract shortcode. Full item: ${JSON.stringify(item).substring(0, 500)}`);
        }
      } else {
        await this.sendInstagramMessage(threadId,
          `Salom! 📥 Ushbu videoni Telegram botingizga yuklash uchun avval akkauntingizni bog'lashingiz kerak.\n\n` +
          `Buning uchun:\n` +
          `1️⃣ Telegram botimizga kiring.\n` +
          `2️⃣ /link @${username} buyrug'ini yuboring.\n` +
          `3️⃣ Bot bergan 4-xonali tasdiqlash kodini bu yerga (Direct'ga) yozib yuboring.`
        );
      }
    }
  }

  private async sendInstagramMessage(threadId: string, text: string): Promise<void> {
    try {
      const clientContext = randomUUID().replace(/-/g, '');
      const params = new URLSearchParams({
        text,
        client_context: clientContext,
        mutation_token: clientContext,
      });
      await this.httpClient.post(
        `/api/v1/direct_v2/threads/${threadId}/broadcast/text/`,
        params.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }
      );
      this.logger.log(`Sent Instagram DM reply to thread ${threadId}`);
    } catch (err: any) {
      this.logger.warn(`Failed to send Instagram DM reply (thread: ${threadId}): ${err.response?.status} ${err.message}`);
    }
  }
}
