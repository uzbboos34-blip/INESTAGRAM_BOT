import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, Context, Markup } from 'telegraf';
import { InstagramService } from '../instagram/instagram.service';
import { DatabaseService } from '../database/database.service';

interface CachedMedia {
  type: 'video' | 'image';
  fileId: string;
}

/**
 * A lightweight, dependency-free FIFO Queue to limit concurrent download/upload executions.
 * Protects proxy pools and Render's free tier (512MB RAM) from crashing during peak loads.
 */
class TaskQueue {
  private running = 0;
  private queue: (() => Promise<void>)[] = [];

  constructor(private readonly concurrency: number) { }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const runTask = async () => {
        this.running++;
        try {
          const result = await task();
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          this.running--;
          this.next();
        }
      };

      this.queue.push(runTask);
      this.next();
    });
  }

  private next() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const nextTask = this.queue.shift();
      if (nextTask) nextTask();
    }
  }
}

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private bot: Telegraf;
  private webhookCallbackFn: any = null;

  // 5 concurrent tasks: optimal balance between download speed and API stability
  private readonly executionQueue = new TaskQueue(5);

  constructor(
    private readonly configService: ConfigService,
    private readonly instagramService: InstagramService,
    private readonly databaseService: DatabaseService,
  ) { }

  async onModuleInit() {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    if (!token || token.includes('YOUR_TELEGRAM_BOT_TOKEN')) {
      this.logger.error('TELEGRAM_BOT_TOKEN is not defined or is set to placeholder in .env!');
      return;
    }

    this.bot = new Telegraf(token);
    this.setupHandlers();

    const useWebhook = this.configService.get<string>('USE_WEBHOOK') === 'true';
    if (useWebhook) {
      const webhookDomain = this.configService.get<string>('WEBHOOK_DOMAIN');
      if (webhookDomain) {
        const webhookUrl = `${webhookDomain}/telegram/webhook`;
        try {
          this.webhookCallbackFn = this.bot.webhookCallback('/telegram/webhook');
          await this.bot.telegram.setWebhook(webhookUrl);
          this.logger.log(`Telegram Bot successfully configured in Webhook mode on: ${webhookUrl}`);
        } catch (err: any) {
          this.logger.error(`Failed to configure Telegram Webhook: ${err.message}`);
        }
      } else {
        this.logger.error('USE_WEBHOOK is set to true, but WEBHOOK_DOMAIN is not defined in .env!');
      }
    } else {
      // Long Polling Mode (Fallback / Local Dev)
      // Wait 5 seconds before launching to let the old Render instance fully
      // release its getUpdates long-poll lock and avoid 409 Conflict errors.
      this.logger.log('USE_WEBHOOK is false/unset. Launching bot in Long Polling mode...');
      this.logger.log('Waiting 5s for previous instance to release Telegram polling lock...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      const launch = async (attempt = 1) => {
        try {
          await this.bot.launch();
          this.logger.log('Telegram Bot successfully launched in Long Polling mode!');
        } catch (err: any) {
          if (err?.response?.error_code === 409 && attempt <= 5) {
            const delay = attempt * 3000;
            this.logger.warn(`409 Conflict on attempt ${attempt}. Retrying in ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
            return launch(attempt + 1);
          }
          this.logger.error('Failed to launch Telegram Bot polling:', err);
        }
      };

      launch();
    }
  }

  async handleWebhookRequest(req: any, res: any) {
    if (this.webhookCallbackFn) {
      try {
        await this.webhookCallbackFn(req, res);
      } catch (err: any) {
        this.logger.error(`Error processing webhook callback payload: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).send('Webhook parsing error');
        }
      }
    } else {
      res.status(400).send('Webhook handler is not initialized');
    }
  }

  onModuleDestroy() {
    if (this.bot) {
      this.bot.stop('SIGTERM');
      this.bot.stop('SIGINT');
      this.logger.log('Telegram Bot stopped gracefully.');
    }
  }

  private setupHandlers() {
    // Start and help commands
    this.bot.start((ctx) => this.sendWelcomeMessage(ctx));
    this.bot.help((ctx) => this.sendWelcomeMessage(ctx));

    // Link Instagram Account Command
    this.bot.command('link', async (ctx) => {
      const text = ctx.message.text.trim();
      const parts = text.split(/\s+/);
      if (parts.length < 2) {
        await ctx.reply(
          "⚠️ *Instagram akkauntni bog'lash:*\n\n" +
          "Iltimos, Instagram profilingiz nomini (username) yuboring.\n" +
          "Masalan:\n`/link profilingiz_nomi`\n\n" +
          "Yoki:\n`/link @profilingiz_nomi`",
          { parse_mode: 'Markdown' }
        );
        return;
      }

      const instagramUsername = parts[1].replace(/^@/, '').toLowerCase().trim();
      if (!instagramUsername || instagramUsername.length < 1) {
        await ctx.reply("❌ Yaroqsiz Instagram foydalanuvchi nomi.");
        return;
      }

      // Generate a random 4-digit code
      const verificationCode = Math.floor(1000 + Math.random() * 9000).toString();

      try {
        await this.databaseService.createOrUpdateMapping(
          instagramUsername,
          ctx.chat.id.toString(),
          verificationCode
        );

        const botUsername = this.configService.get<string>('INSTAGRAM_BOT_USERNAME') || 'Instagram_Bot';
        const instructionText =
          `🔗 *Instagram akkauntni bog'lash:*\n\n` +
          `Sizning Instagram nikingiz: *@${instagramUsername}*\n` +
          `Tasdiqlash kodi: \`${verificationCode}\`\n\n` +
          `Akkauntingizni tasdiqlash uchun quyidagi amallarni bajaring:\n` +
          `1️⃣ Instagram'da *@${botUsername}* akkaunti Direct (DM)iga kiring.\n` +
          `2️⃣ Unga faqatgina mana shu \`${verificationCode}\` kodini yozib yuboring.\n\n` +
          `Tizim kodni qabul qilgach, ushbu Telegram bot sizga tasdiqlash xabarini yuboradi.`;

        await ctx.reply(instructionText, { parse_mode: 'Markdown' });
      } catch (err: any) {
        await ctx.reply(`❌ Akkauntni bog'lashda xatolik yuz berdi: ${err.message}`);
      }
    });

    // Clear Cache Command (For developer testing)
    this.bot.command('clear', async (ctx) => {
      try {
        await this.databaseService.clearCache();
        await ctx.reply('Kesh muvaffaqiyatli tozalandi! ✅ (SQLite va Redis bo\'shatildi)');
      } catch (err: any) {
        await ctx.reply(`Keshni tozalashda xatolik yuz berdi: ${err.message}`);
      }
    });

    // Callback Query Handler for Inline Buttons
    this.bot.on('callback_query', async (ctx) => {
      const data = (ctx.callbackQuery as any).data;
      if (!data) return;

      if (data === 'del') {
        try {
          await ctx.deleteMessage();
          await ctx.answerCbQuery('Fayl o\'chirildi! 🗑️');
        } catch (err: any) {
          this.logger.warn(`Failed to delete message via callback: ${err.message}`);
          await ctx.answerCbQuery('Xabar o\'chirilishi mumkin emas.');
        }
      } else if (data.startsWith('desc:')) {
        const shortcode = data.split(':')[1];
        await ctx.answerCbQuery('Tavsif yuklanmoqda... ⏳');

        try {
          // Check cache first using shortcode
          const cachedCaption = await this.databaseService.getCaption(shortcode);
          if (cachedCaption) {
            await ctx.reply(cachedCaption, { parse_mode: 'Markdown' });
            return;
          }

          // Fallback to scraping
          const caption = await this.instagramService.getPostCaption(shortcode);
          if (caption) {
            await this.databaseService.setCaption(shortcode, caption);
            await ctx.reply(caption, { parse_mode: 'Markdown' });
          } else {
            await ctx.reply('📝 *Tavsif:*\n\nInstagram videodan matnli tavsif olinmadi (post muallifi matn yozmagan yoki havola shaxsiy).', { parse_mode: 'Markdown' });
          }
        } catch (err: any) {
          await ctx.reply('❌ Tavsifni yuklab bo\'lmadi.');
        }
      } else if (data.startsWith('mp3:')) {
        const shortcode = data.split(':')[1];
        await ctx.answerCbQuery('Audio (MP3) tayyorlanmoqda... ⏳');

        try {
          // Check Cache First using shortcode (Serve audio file_id instantly in 0.01 seconds!)
          const cached = await this.databaseService.getCache(shortcode);
          if (cached) {
            const cachedAudio = cached.find(i => i.type === 'audio');
            if (cachedAudio) {
              this.logger.log(`[Instant Audio Cache Hit] Serving cached audio fileId for shortcode: ${shortcode}`);
              await ctx.replyWithAudio(cachedAudio.fileId);
              return;
            }
          }

          // Miss: Download and stream as audio (using standard URL structure)
          const instagramUrl = `https://www.instagram.com/reel/${shortcode}/`;
          const mediaData = await this.instagramService.getMediaUrls(instagramUrl);
          const cdnUrl = mediaData.url_list?.[0];
          if (cdnUrl) {
            const { stream } = await this.instagramService.downloadMediaStream(cdnUrl);
            const msg = await ctx.replyWithAudio({ source: stream, filename: `${shortcode}.mp3` }, {
              title: 'Audio Track',
              performer: 'Instagram Bot',
            });

            // Extract file_id and cache it in SQLite/Redis
            const audioFileId = msg?.audio?.file_id;
            if (audioFileId) {
              const updatedCache = cached ? [...cached] : [];
              updatedCache.push({ type: 'audio', fileId: audioFileId });
              await this.databaseService.setCache(shortcode, updatedCache);
              this.logger.log(`[Audio Cache Populate] Saved audio file_id to database for shortcode: ${shortcode}`);
            }
          } else {
            throw new Error('Video havola topilmadi.');
          }
        } catch (err: any) {
          this.logger.error(`Failed to process MP3 callback: ${err.message}`);
          await ctx.reply(`❌ Audioni yuklab bo'lmadi: ${err.message}`);
        }
      }
    });

    // Handle text messages (Instagram URLs)
    this.bot.on('text', async (ctx) => {
      if (!ctx.chat) return;
      const text = ctx.message.text.trim();

      if (this.instagramService.isValidUrl(text)) {
        const shortcode = this.instagramService.extractShortcode(text);

        try {
          // CHECK CACHE FIRST using shortcode (Bypasses queue and delays entirely for instant delivery!)
          const cached = await this.databaseService.getCache(shortcode);
          if (cached && cached.length > 0) {
            this.logger.log(`[Instant DB Cache Hit] Serving cached file_id for shortcode: ${shortcode}`);

            const extra = Markup.inlineKeyboard([
              [
                Markup.button.callback('🗑️ O\'chirish', 'del'),
                Markup.button.callback('📝 Tavsif', `desc:${shortcode}`),
              ],
              [
                Markup.button.callback('🎵 MP3', `mp3:${shortcode}`),
              ]
            ]).reply_markup;

            for (const item of cached) {
              if (item.type === 'video') {
                await ctx.replyWithVideo(item.fileId, { caption: '✅ Video tayyor!', reply_markup: extra });
              } else if (item.type === 'image') {
                await ctx.replyWithPhoto(item.fileId, { caption: '✅ Rasm tayyor!', reply_markup: extra });
              }
            }
            return;
          }
        } catch (err: any) {
          this.logger.warn(`Failed to execute fast cache check: ${err.message}`);
        }

        // Only if NOT cached, run inside the queue with stagger delay
        this.executionQueue.run(async () => {
          // Add a random delay (0.5s to 2.0s) to spread requests and avoid workers.dev rate limits
          const randomDelay = Math.floor(Math.random() * 1500) + 500;
          await new Promise(resolve => setTimeout(resolve, randomDelay));
          await this.handleInstagramDownload(ctx, text);
        }).catch(err => {
          this.logger.error(`Error handling download in queue: ${err.message}`);
        });
      } else {
        ctx.reply(
          "Iltimos, menga haqiqiy Instagram video/rasm havolasini yuboring (Reel, Post yoki IGTV).\n\n" +
          "Masalan:\n`https://www.instagram.com/reel/C8r...`",
          { parse_mode: 'Markdown' }
        );
      }
    });
  }

  private async sendWelcomeMessage(ctx: Context) {
    const welcomeText =
      `👋 Salom, *${ctx.from?.first_name || "do'st"}*!\n\n` +
      `Men Instagram-dan video va rasmlarni yuklab beruvchi botman.\n\n` +
      `📥 Yuklab olish uchun menga biror **Instagram link** (Reels, Post, IGTV) yuboring.`;
    await ctx.reply(welcomeText, { parse_mode: 'Markdown' });
  }

  /**
   * Extracts the file_id from a Telegram message response.
   */
  private extractFileId(message: any): CachedMedia | null {
    if (!message) return null;
    if (message.video && message.video.file_id) {
      return { type: 'video', fileId: message.video.file_id };
    }
    if (message.photo && message.photo.length > 0) {
      const lastPhoto = message.photo[message.photo.length - 1];
      return { type: 'image', fileId: lastPhoto.file_id };
    }
    return null;
  }

  private async handleInstagramDownload(ctx: Context, url: string) {
    if (!ctx.chat) return;
    let loadingMsg: any = null;
    try {
      // Send Loading Message
      try {
        loadingMsg = await ctx.reply('⏳ Yuklanmoqda...');
      } catch (err) {
        this.logger.warn(`Failed to send loading message: ${err.message}`);
      }

      const shortcode = this.instagramService.extractShortcode(url);

      const extra = Markup.inlineKeyboard([
        [
          Markup.button.callback('🗑️ O\'chirish', 'del'),
          Markup.button.callback('📝 Tavsif', `desc:${shortcode}`),
        ],
        [
          Markup.button.callback('🎵 MP3', `mp3:${shortcode}`),
        ]
      ]).reply_markup;

      // --- LAYER 1: Check Database Cache using shortcode ---
      const cached = await this.databaseService.getCache(shortcode);
      if (cached && cached.length > 0) {
        this.logger.log(`[DB Cache Hit] Serving cached file_id for shortcode: ${shortcode}`);

        // Delete loading message before sending cached media to avoid any latency feeling
        if (loadingMsg) {
          try {
            await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
            loadingMsg = null;
          } catch (e) {}
        }

        for (const item of cached) {
          const startCachedSend = Date.now();
          if (item.type === 'video') {
            await ctx.replyWithVideo(item.fileId, { caption: '✅ Video tayyor!', reply_markup: extra });
          } else {
            await ctx.replyWithPhoto(item.fileId, { caption: '✅ Rasm tayyor!', reply_markup: extra });
          }
          this.logger.log(`[Cache Delivery] Cached item sent to user in ${Date.now() - startCachedSend}ms`);
        }
        return; // Complete download bypass, instantaneous!
      }

      // --- LAYER 2: Scraping fallback (First-time request) ---
      const startScrape = Date.now();
      const mediaData = await this.instagramService.getMediaUrls(url);
      this.logger.log(`Instagram scraping completed in ${Date.now() - startScrape}ms`);

      // Delete loading message just before sending media to keep chat tidy
      if (loadingMsg) {
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
          loadingMsg = null;
        } catch (e) {}
      }

      const details = mediaData.media_details || [];
      const urls = mediaData.url_list || [];
      const sentMediaItems: CachedMedia[] = [];

      if (details.length > 0) {
        for (const detail of details) {
          const sent = await this.sendMediaDetail(ctx, detail, shortcode);
          if (sent) sentMediaItems.push(sent);
        }
      } else if (urls.length > 0) {
        for (const mediaUrl of urls) {
          const isVideo = mediaUrl.includes('.mp4') || mediaUrl.includes('video') || mediaUrl.includes('&mime=video');
          const sent = await this.sendMediaByUrl(ctx, mediaUrl, isVideo ? 'video' : 'image', shortcode);
          if (sent) sentMediaItems.push(sent);
        }
      } else {
        throw new Error('Hech qanday media fayli topilmadi.');
      }

      // Save file_ids to database for future instant delivery using shortcode
      if (sentMediaItems.length > 0) {
        await this.databaseService.setCache(shortcode, sentMediaItems);
        this.logger.log(`[DB Cache Populate] Saved ${sentMediaItems.length} media item(s) to SQLite/Redis for shortcode: ${shortcode}`);
      }

    } catch (error: any) {
      this.logger.error(`Failed to handle download for ${url}: ${error.message}`);

      if (loadingMsg) {
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
        } catch (e) {}
      }

      if (error.message.startsWith('FILE_TOO_LARGE:')) {
        const parts = error.message.split(':');
        const lengthBytes = parseInt(parts[1], 10);
        const cdnUrl = parts.slice(2).join(':');
        const sizeMb = lengthBytes > 0 ? (lengthBytes / (1024 * 1024)).toFixed(1) : '50+';

        const largeFileMessage =
          `⚠️ *Video hajmi juda katta!* (${sizeMb} MB)\n\n` +
          `Telegram Bot API botlar orqali maksimal *50 MB* gacha bo'lgan fayllarni yuklashga ruxsat beradi.\n\n` +
          `Siz ushbu videoni quyidagi havola orqali brauzeringizda to'g'ridan-to'g'ri yuklab olishingiz mumkin:\n` +
          `📥 [Videoni yuklab olish](${cdnUrl})`;

        await ctx.reply(largeFileMessage, { parse_mode: 'Markdown' });
        return;
      }

      const errorMessage = `❌ *Xatolik yuz berdi:*\n${error.message || 'Videoni yuklab bo\'lmadi. Havola ochiq (public) ekanligiga ishonch hosil qiling.'}`;
      await ctx.reply(errorMessage, { parse_mode: 'Markdown' });
    }
  }

  private async sendMediaDetail(ctx: Context, detail: any, shortcode: string): Promise<CachedMedia | null> {
    const cdnUrl = detail.url;
    const detailFilename = (detail.filename || '').toLowerCase();
    const isVideo = detail.type === 'video' || detailFilename.endsWith('.mp4') || cdnUrl.toLowerCase().includes('.mp4');

    const extra = Markup.inlineKeyboard([
      [
        Markup.button.callback('🗑️ O\'chirish', 'del'),
        Markup.button.callback('📝 Tavsif', `desc:${shortcode}`),
      ],
      [
        Markup.button.callback('🎵 MP3', `mp3:${shortcode}`),
      ]
    ]).reply_markup;

    const startDirectUrlSend = Date.now();
    try {
      this.logger.log(`Attempting to send media directly by URL to speed up delivery...`);
      let msg: any;
      if (isVideo) {
        msg = await ctx.replyWithVideo(cdnUrl, { caption: '✅ Video tayyor!', reply_markup: extra });
      } else {
        msg = await ctx.replyWithPhoto(cdnUrl, { caption: '✅ Rasm tayyor!', reply_markup: extra });
      }
      this.logger.log(`Direct URL send succeeded in ${Date.now() - startDirectUrlSend}ms.`);
      return this.extractFileId(msg);
    } catch (err: any) {
      this.logger.warn(`Failed to send via direct URL: ${err.message}. Falling back to streaming pipeline...`);

      try {
        // --- HIGH SPEED DIRECT STREAMING PIPELINE ---
        const { stream, mimeType, contentLength } = await this.instagramService.downloadMediaStream(cdnUrl);

        // Pre-check size limit of 50MB
        if (contentLength && parseInt(contentLength, 10) > 50 * 1024 * 1024) {
          throw new Error(`FILE_TOO_LARGE:${contentLength}:${cdnUrl}`);
        }

        const realIsVideo =
          mimeType.toLowerCase().includes('video') ||
          mimeType.toLowerCase().includes('mp4') ||
          detailFilename.endsWith('.mp4');

        this.logger.log(`Piping stream to Telegram. mimeType: ${mimeType}. Length: ${contentLength || 'unknown'}`);

        const uploadStart = Date.now();
        let msg: any;

        const sourceObj: any = {
          source: stream,
          filename: detail.filename || (realIsVideo ? 'video.mp4' : 'image.jpg'),
        };
        if (contentLength) {
          sourceObj.knownLength = parseInt(contentLength, 10);
        }

        try {
          if (realIsVideo) {
            msg = await ctx.replyWithVideo(sourceObj, { caption: '✅ Video tayyor!', reply_markup: extra });
          } else {
            msg = await ctx.replyWithPhoto(sourceObj, { caption: '✅ Rasm tayyor!', reply_markup: extra });
          }
        } catch (uploadErr: any) {
          // If Telegram API rejects it during upload with size limits:
          if (uploadErr.message?.includes('413') || uploadErr.message?.includes('too large') || uploadErr.message?.includes('Request Entity Too Large')) {
            throw new Error(`FILE_TOO_LARGE:${contentLength || 0}:${cdnUrl}`);
          }
          throw uploadErr;
        }

        this.logger.log(`Telegram upload pipeline completed in ${Date.now() - uploadStart}ms`);
        return this.extractFileId(msg);
      } catch (fallbackErr: any) {
        // If it's our custom size-limit error, bubble it up directly to handleInstagramDownload!
        if (fallbackErr.message?.startsWith('FILE_TOO_LARGE:')) {
          throw fallbackErr;
        }

        this.logger.error(`Streaming pipeline failed: ${fallbackErr.message}`);
        return await this.sendMediaByUrl(ctx, cdnUrl, isVideo ? 'video' : 'image', shortcode);
      }
    }
  }

  private async sendMediaByUrl(ctx: Context, url: string, type: 'video' | 'image', shortcode: string): Promise<CachedMedia | null> {
    const startSend = Date.now();
    let msg: any;

    const extra = Markup.inlineKeyboard([
      [
        Markup.button.callback('🗑️ O\'chirish', 'del'),
        Markup.button.callback('📝 Tavsif', `desc:${shortcode}`),
      ],
      [
        Markup.button.callback('🎵 MP3', `mp3:${shortcode}`),
      ]
    ]).reply_markup;

    try {
      if (type === 'video') {
        msg = await ctx.replyWithVideo(url, { caption: '✅ Video tayyor!', reply_markup: extra });
      } else {
        msg = await ctx.replyWithPhoto(url, { caption: '✅ Rasm tayyor!', reply_markup: extra });
      }
      this.logger.log(`SendMediaByUrl finished in ${Date.now() - startSend}ms`);
      return this.extractFileId(msg);
    } catch (err: any) {
      if (err.message?.includes('413') || err.message?.includes('too large') || err.message?.includes('Request Entity Too Large') || err.message?.includes('HTTP URL content')) {
        throw new Error(`FILE_TOO_LARGE:0:${url}`);
      }
      throw err;
    }
  }

  /**
   * Helper to send direct text message to a user.
   */
  async sendDirectMessage(telegramChatId: string, text: string, options?: any): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(telegramChatId, text, options);
    } catch (err: any) {
      this.logger.error(`Failed to send direct message to ${telegramChatId}: ${err.message}`);
    }
  }

  /**
   * Deliver shared Instagram Reel/Post to a user by mimicking Telegram message context.
   */
  async deliverSharedMedia(telegramChatId: string, shortcode: string, instagramUsername: string): Promise<void> {
    const url = `https://www.instagram.com/reel/${shortcode}/`;
    
    // Create a mock context wrapper to reuse all logic, queueing, caching, stream fallback, limits, etc.
    const mockCtx = {
      chat: { id: parseInt(telegramChatId, 10) },
      from: { first_name: instagramUsername },
      telegram: this.bot.telegram,
      reply: (text: string, extra?: any) => this.bot.telegram.sendMessage(telegramChatId, text, extra),
      replyWithVideo: (video: any, extra?: any) => this.bot.telegram.sendVideo(telegramChatId, video, extra),
      replyWithPhoto: (photo: any, extra?: any) => this.bot.telegram.sendPhoto(telegramChatId, photo, extra),
      replyWithAudio: (audio: any, extra?: any) => this.bot.telegram.sendAudio(telegramChatId, audio, extra),
    } as any;

    // Run within the execution queue with delay to protect limits and avoid crashing Render
    this.executionQueue.run(async () => {
      const randomDelay = Math.floor(Math.random() * 1500) + 500;
      await new Promise(resolve => setTimeout(resolve, randomDelay));
      await this.handleInstagramDownload(mockCtx, url);
    }).catch(err => {
      this.logger.error(`Error handling shared media delivery in queue: ${err.message}`);
    });
  }
}
