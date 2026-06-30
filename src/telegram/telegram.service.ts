import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf, Context } from 'telegraf';
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

    // Clear Cache Command (For developer testing)
    this.bot.command('clear', async (ctx) => {
      try {
        await this.databaseService.clearCache();
        await ctx.reply('Kesh muvaffaqiyatli tozalandi! ✅ (SQLite va Redis bo\'shatildi)');
      } catch (err: any) {
        await ctx.reply(`Keshni tozalashda xatolik yuz berdi: ${err.message}`);
      }
    });

    // Handle text messages (Instagram URLs)
    this.bot.on('text', (ctx) => {
      if (!ctx.chat) return;
      const text = ctx.message.text.trim();

      if (this.instagramService.isValidUrl(text)) {
        // Wrap the execution inside our concurrency queue to protect resources
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

      const normalizedUrl = this.instagramService.normalizeUrl(url);

      // --- LAYER 1: Check PostgreSQL Database Cache ---
      const cached = await this.databaseService.getCache(normalizedUrl);
      if (cached && cached.length > 0) {
        this.logger.log(`[DB Cache Hit] Serving cached file_id for URL: ${normalizedUrl}`);

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
            await ctx.replyWithVideo(item.fileId, { caption: 'Downloaded via @insta_media_load_bot' });
          } else {
            await ctx.replyWithPhoto(item.fileId, { caption: 'Downloaded via @insta_media_load_bot' });
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
          const sent = await this.sendMediaDetail(ctx, detail);
          if (sent) sentMediaItems.push(sent);
        }
      } else if (urls.length > 0) {
        for (const mediaUrl of urls) {
          const isVideo = mediaUrl.includes('.mp4') || mediaUrl.includes('video') || mediaUrl.includes('&mime=video');
          const sent = await this.sendMediaByUrl(ctx, mediaUrl, isVideo ? 'video' : 'image');
          if (sent) sentMediaItems.push(sent);
        }
      } else {
        throw new Error('Hech qanday media fayli topilmadi.');
      }

      // Save file_ids to PostgreSQL database for future instant delivery
      if (sentMediaItems.length > 0) {
        await this.databaseService.setCache(normalizedUrl, sentMediaItems);
        this.logger.log(`[DB Cache Populate] Saved ${sentMediaItems.length} media item(s) to SQLite/Redis for URL: ${normalizedUrl}`);
      }

    } catch (error) {
      this.logger.error(`Failed to handle download for ${url}: ${error.message}`);

      // Delete loading message if error occurred
      if (loadingMsg) {
        try {
          await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id);
        } catch (e) {}
      }

      const errorMessage = `❌ *Xatolik yuz berdi:*\n${error.message || 'Videoni yuklab bo\'lmadi. Havola ochiq (public) ekanligiga ishonch hosil qiling.'}`;
      await ctx.reply(errorMessage, { parse_mode: 'Markdown' });
    }
  }

  private async sendMediaDetail(ctx: Context, detail: any): Promise<CachedMedia | null> {
    const cdnUrl = detail.url;
    const detailFilename = (detail.filename || '').toLowerCase();
    const isVideo = detail.type === 'video' || detailFilename.endsWith('.mp4') || cdnUrl.toLowerCase().includes('.mp4');

    const startDirectUrlSend = Date.now();
    try {
      this.logger.log(`Attempting to send media directly by URL to speed up delivery...`);
      let msg: any;
      if (isVideo) {
        msg = await ctx.replyWithVideo(cdnUrl, { caption: 'Downloaded via @insta_media_load_bot' });
      } else {
        msg = await ctx.replyWithPhoto(cdnUrl, { caption: 'Downloaded via @insta_media_load_bot' });
      }
      this.logger.log(`Direct URL send succeeded in ${Date.now() - startDirectUrlSend}ms.`);
      return this.extractFileId(msg);
    } catch (err) {
      this.logger.warn(`Failed to send via direct URL: ${err.message}. Falling back to streaming pipeline...`);

      try {
        // --- HIGH SPEED DIRECT STREAMING PIPELINE ---
        const { stream, mimeType, contentLength } = await this.instagramService.downloadMediaStream(cdnUrl);

        const realIsVideo =
          mimeType.toLowerCase().includes('video') ||
          mimeType.toLowerCase().includes('mp4') ||
          detailFilename.endsWith('.mp4');

        this.logger.log(`Piping stream to Telegram. mimeType: ${mimeType}. Length: ${contentLength || 'unknown'}`);

        const uploadStart = Date.now();
        let msg: any;

        // Formulate stream object options with optional knownLength
        const sourceObj: any = {
          source: stream,
          filename: detail.filename || (realIsVideo ? 'video.mp4' : 'image.jpg'),
        };
        if (contentLength) {
          sourceObj.knownLength = parseInt(contentLength, 10);
        }

        if (realIsVideo) {
          msg = await ctx.replyWithVideo(sourceObj, { caption: 'Downloaded via @insta_media_load_bot' });
        } else {
          msg = await ctx.replyWithPhoto(sourceObj, { caption: 'Downloaded via @insta_media_load_bot' });
        }

        this.logger.log(`Telegram upload pipeline completed in ${Date.now() - uploadStart}ms`);
        return this.extractFileId(msg);
      } catch (fallbackErr) {
        this.logger.error(`Streaming pipeline failed: ${fallbackErr.message}`);
        return await this.sendMediaByUrl(ctx, cdnUrl, isVideo ? 'video' : 'image');
      }
    }
  }

  private async sendMediaByUrl(ctx: Context, url: string, type: 'video' | 'image'): Promise<CachedMedia | null> {
    const startSend = Date.now();
    let msg: any;
    if (type === 'video') {
      msg = await ctx.replyWithVideo(url, { caption: 'Downloaded via @insta_media_load_bot' });
    } else {
      msg = await ctx.replyWithPhoto(url, { caption: 'Downloaded via @insta_media_load_bot' });
    }
    this.logger.log(`SendMediaByUrl finished in ${Date.now() - startSend}ms`);
    return this.extractFileId(msg);
  }
}
