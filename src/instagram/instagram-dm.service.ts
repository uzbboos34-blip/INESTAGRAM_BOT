import { Injectable, Inject, forwardRef, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IgApiClient, IgCheckpointError } from 'instagram-private-api';
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

    // Override outdated constants to bypass "unsupported_version" blocks
    const constants = this.ig.state.constants as any;
    constants.APP_VERSION = '320.0.0.42.101';
    constants.APP_VERSION_CODE = '372011650';

    this.ig.state.generateDevice(username);
    // Override to a modern Android 12 device and build matching Instagram v320
    this.ig.state.deviceString = '31/12; 480dpi; 1080x2340; samsung; SM-S901B; galaxy-s22; samsungexynos2200';
    this.ig.state.build = '320.0.0.42.101';

    // Attach Bot Specific Proxy if defined in .env, fallback to first proxy from PROXY_POOL
    let botProxy = this.configService.get<string>('INSTAGRAM_BOT_PROXY');
    if (botProxy === 'none') {
      this.logger.log('INSTAGRAM_BOT_PROXY is set to "none". Connecting directly without proxy.');
      botProxy = undefined;
    } else if (!botProxy) {
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
      if (!botProxy.startsWith('http://') && !botProxy.startsWith('https://')) {
        botProxy = `http://${botProxy}`;
      }

      const safeLogProxy = botProxy.includes('@') ? botProxy.split('@')[1] : botProxy;
      this.logger.log(`Using proxy for Instagram Bot client: ${safeLogProxy}`);
      this.ig.state.proxyUrl = botProxy;

      try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        const agent = new HttpsProxyAgent(botProxy);
        this.ig.request.defaults = { agent };
        this.logger.log('Successfully configured HttpsProxyAgent for authenticated proxy tunneling.');
      } catch (agentErr: any) {
        this.logger.error(`Failed to configure HttpsProxyAgent: ${agentErr.message}`);
      }
    }

    try {
      // 1. Try to load INSTAGRAM_BOT_COOKIE if provided (bypasses login and works 100%!)
      const botCookie = this.configService.get<string>('INSTAGRAM_BOT_COOKIE');
      if (botCookie) {
        this.logger.log('Loading Instagram Bot Cookie from configuration...');
        await this.loadCookieString(botCookie);
        try {
          // Bypassing active endpoint validation during startup to prevent block list checks.
          // The cookie will be verified naturally when the polling worker requests directInbox.
          this.logger.log(`Successfully loaded cookie string into client session.`);
          this.isLoggedIn = true;

          // Save the serialized session so next restarts read from DB
          const serialized = await this.ig.state.serialize();
          await this.databaseService.saveSession(JSON.stringify(serialized));
        } catch (cookieErr: any) {
          this.logger.warn(`Configured INSTAGRAM_BOT_COOKIE loading failed: ${cookieErr.message}. Trying DB or Login...`);
        }
      }

      // 2. Try to load saved session from database to avoid fresh logins and blocks
      if (!this.isLoggedIn) {
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
      }

      // 3. Perform fresh login if session couldn't be recovered
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

      // 4. Start Polling DMs
      this.startPolling();

    } catch (err: any) {
      const constructorName = err?.constructor?.name || 'UnknownError';
      const errorMessage = err?.message || '';
      const isCheckpoint = 
        err instanceof IgCheckpointError || 
        constructorName === 'IgCheckpointError' || 
        errorMessage.includes('checkpoint_required');

      this.logger.warn(`Instagram DM Client initialization encountered an error:`);
      this.logger.warn(`- Error class: ${constructorName}`);
      this.logger.warn(`- Error message: ${errorMessage}`);
      if (err.response && err.response.body) {
        this.logger.warn(`- Error response body: ${JSON.stringify(err.response.body)}`);
      }
      this.logger.warn(`- Detected as checkpoint: ${isCheckpoint}`);

      if (isCheckpoint) {
        this.logger.warn('Instagram login requires verification (Checkpoint). Requesting verification code...');
        try {
          let hasApiPath = false;
          // Manually extract and assign checkpoint details from error response body
          if (err.response && err.response.body) {
            if (err.response.body.challenge) {
              this.ig.state.checkpoint = err.response.body;
              if (err.response.body.challenge.api_path) {
                hasApiPath = true;
              }
            } else {
              this.ig.state.checkpoint = { challenge: err.response.body } as any;
              if (err.response.body.api_path) {
                hasApiPath = true;
              }
            }
          }

          if (hasApiPath) {
            // Trigger code delivery automatically
            const challengeInfo = await this.ig.challenge.auto(true);
            this.logger.log(`Challenge auto result: ${JSON.stringify(challengeInfo)}`);
            this.logger.log('Verification code has been requested and sent! Please check your Email or SMS.');
            this.logger.log('Use command: /confirm <verification_code> in the Telegram bot to finalize the connection.');
          } else {
            const checkpointUrl = err.response?.body?.checkpoint_url || '';
            this.logger.error(`Checkpoint requires manual verification. No API path was provided by Instagram.`);
            if (checkpointUrl) {
              this.logger.error(`Please open this URL in your browser to verify the login attempt: ${checkpointUrl}`);
            }
          }
        } catch (challengeErr: any) {
          this.logger.error(`Failed to request challenge code: ${challengeErr.message}`);
        }
      } else {
        this.logger.error(`Failed to initialize Instagram DM Client: ${err.stack || err.message}`);
      }
    }
  }

  async verifyChallenge(code: string): Promise<boolean> {
    try {
      this.logger.log(`Attempting to verify checkpoint with code: ${code}`);
      await this.ig.challenge.sendSecurityCode(code);
      this.logger.log('Checkpoint verified successfully! Session initialized.');
      this.isLoggedIn = true;

      // Save serialized session state back to database
      const serialized = await this.ig.state.serialize();
      await this.databaseService.saveSession(JSON.stringify(serialized));
      this.logger.log('Successfully saved session state to database SQLite.');

      // Start Polling DMs
      this.startPolling();
      return true;
    } catch (err: any) {
      this.logger.error(`Failed to verify checkpoint code: ${err.message}`);
      return false;
    }
  }

  private async loadCookieString(cookieString: string) {
    const { Cookie } = require('tough-cookie');
    const cookies = cookieString.split(';').map(c => c.trim()).filter(Boolean);
    for (const c of cookies) {
      const cookie = Cookie.parse(c);
      if (cookie) {
        cookie.domain = 'instagram.com';
        await this.ig.state.cookieJar.setCookie(cookie, 'https://instagram.com');
        if (cookie.key === 'ig_did') {
          const igDidValue = cookie.value;
          this.ig.state.uuid = igDidValue;
          this.ig.state.phoneId = igDidValue;
          this.ig.state.deviceId = `android-${igDidValue}`;
          this.ig.state.adid = igDidValue;
          this.logger.log(`Aligned device identifiers with cookie ig_did: ${igDidValue}`);
        }
      }
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
