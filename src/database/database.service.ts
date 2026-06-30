import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { open, Database } from 'sqlite';
import * as sqlite3 from 'sqlite3';
import Redis from 'ioredis';
import * as path from 'path';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private db: Database | null = null;
  private redis: Redis | null = null;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    // --- REDIS CONFIGURATION ---
    const redisUrl = this.configService.get<string>('REDIS_URL');
    if (redisUrl) {
      try {
        this.redis = new Redis(redisUrl, {
          maxRetriesPerRequest: 1,
          connectTimeout: 5000,
        });

        this.redis.on('connect', () => {
          this.logger.log('Successfully connected to Redis cache!');
        });

        this.redis.on('error', (err) => {
          this.logger.warn(`Redis connection error: ${err.message}`);
        });
      } catch (err) {
        this.logger.warn(`Failed to initialize Redis: ${err.message}`);
      }
    } else {
      this.logger.log('REDIS_URL is not set. Running in SQLite-only cache mode.');
    }

    // --- SQLITE CONFIGURATION ---
    const dbFile = this.configService.get<string>('DATABASE_FILE') || 'database.db';
    const dbPath = path.isAbsolute(dbFile) ? dbFile : path.join(process.cwd(), dbFile);

    try {
      this.db = await open({
        filename: dbPath,
        driver: sqlite3.Database
      });
      this.logger.log(`Successfully connected to SQLite database at: ${dbPath}`);

      // Initialize Cache Schema
      await this.initSchema();
    } catch (err) {
      this.logger.error(`SQLite connection/init failed: ${err.message}`);
    }
  }

  async onModuleDestroy() {
    if (this.redis) {
      try {
        await this.redis.quit();
        this.logger.log('Redis connection closed.');
      } catch (err) {
        this.logger.warn(`Error closing Redis connection: ${err.message}`);
      }
    }

    if (this.db) {
      try {
        await this.db.close();
        this.logger.log('SQLite database connection closed.');
      } catch (err) {
        this.logger.warn(`Error closing SQLite connection: ${err.message}`);
      }
    }
  }

  private async initSchema() {
    if (!this.db) return;
    const query = `
      CREATE TABLE IF NOT EXISTS instagram_cache (
        instagram_url TEXT PRIMARY KEY,
        media_data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `;
    try {
      await this.db.run(query);
      this.logger.log('SQLite cache table instagram_cache initialized/verified.');
      
      // Dynamically add caption column if missing
      try {
        await this.db.run('ALTER TABLE instagram_cache ADD COLUMN caption TEXT;');
        this.logger.log('SQLite schema updated with caption column.');
      } catch (e) {
        // Column already exists, safe to ignore
      }
    } catch (err) {
      this.logger.error(`Failed to initialize SQLite schema: ${err.message}`);
    }
  }

  async getCaption(instagramUrl: string): Promise<string | null> {
    const redisKey = `ig_caption:${instagramUrl}`;

    // 1. Try Redis first
    if (this.redis) {
      try {
        const cached = await this.redis.get(redisKey);
        if (cached) return cached;
      } catch (err) {
        this.logger.warn(`Redis getCaption failed: ${err.message}`);
      }
    }

    // 2. Fallback to SQLite
    if (!this.db) return null;
    const query = 'SELECT caption FROM instagram_cache WHERE instagram_url = ?';
    try {
      const row = await this.db.get(query, [instagramUrl]);
      if (row && row.caption) {
        if (this.redis) {
          this.redis.set(redisKey, row.caption, 'EX', 2 * 24 * 60 * 60).catch(() => {});
        }
        return row.caption;
      }
    } catch (err) {
      this.logger.error(`Error querying caption from SQLite: ${err.message}`);
    }
    return null;
  }

  async setCaption(instagramUrl: string, caption: string): Promise<void> {
    const redisKey = `ig_caption:${instagramUrl}`;

    // 1. Write to SQLite
    if (this.db) {
      try {
        // Try to insert OR update existing row
        await this.db.run(
          'INSERT INTO instagram_cache (instagram_url, media_data, caption) VALUES (?, ?, ?) ON CONFLICT(instagram_url) DO UPDATE SET caption = excluded.caption',
          [instagramUrl, '[]', caption]
        );
      } catch (err) {
        // Fallback update if sqlite version lacks ON CONFLICT support
        try {
          await this.db.run('UPDATE instagram_cache SET caption = ? WHERE instagram_url = ?', [caption, instagramUrl]);
        } catch (updateErr) {
          this.logger.error(`Failed to update caption in SQLite: ${updateErr.message}`);
        }
      }
    }

    // 2. Write to Redis
    if (this.redis) {
      try {
        await this.redis.set(redisKey, caption, 'EX', 2 * 24 * 60 * 60);
      } catch (err) {
        this.logger.warn(`Failed to save caption to Redis: ${err.message}`);
      }
    }
  }

  async getCache(instagramUrl: string): Promise<any[] | null> {
    const redisKey = `ig_cache:${instagramUrl}`;

    // 1. Try Redis first (sub-millisecond lookup)
    if (this.redis) {
      try {
        const cached = await this.redis.get(redisKey);
        if (cached) {
          this.logger.log(`[Redis Cache Hit] Serving cached file_id for URL: ${instagramUrl}`);
          return JSON.parse(cached);
        }
      } catch (err) {
        this.logger.warn(`Redis getCache failed: ${err.message}`);
      }
    }

    // 2. Fall back to SQLite
    if (!this.db) return null;
    const query = 'SELECT media_data FROM instagram_cache WHERE instagram_url = ?';
    try {
      const row = await this.db.get(query, [instagramUrl]);
      if (row) {
        try {
          const data = JSON.parse(row.media_data);

          // Populate Redis cache asynchronously for next time (Expires in 2 days to keep memory usage under 25MB)
          if (this.redis && data) {
            this.redis.set(redisKey, row.media_data, 'EX', 2 * 24 * 60 * 60).catch((redisErr) => {
              this.logger.warn(`Failed to populate Redis cache asynchronously: ${redisErr.message}`);
            });
          }

          return data;
        } catch (jsonErr) {
          this.logger.error(`Failed to parse cached JSON from SQLite for ${instagramUrl}: ${jsonErr.message}`);
        }
      }
    } catch (err) {
      this.logger.error(`Error querying cache from SQLite: ${err.message}`);
    }
    return null;
  }

  async setCache(instagramUrl: string, mediaData: any[]): Promise<void> {
    const redisKey = `ig_cache:${instagramUrl}`;
    const stringifiedData = JSON.stringify(mediaData);

    // 1. Write to SQLite (for long-term persistent storage)
    if (this.db) {
      const query = `
        INSERT OR REPLACE INTO instagram_cache (instagram_url, media_data)
        VALUES (?, ?);
      `;
      try {
        await this.db.run(query, [instagramUrl, stringifiedData]);
        this.logger.log(`Saved cache to SQLite for URL: ${instagramUrl}`);
      } catch (err) {
        this.logger.error(`Error saving cache to SQLite: ${err.message}`);
      }
    }

    // 2. Write to Redis with 2-day TTL (keeps memory size tiny)
    if (this.redis) {
      try {
        await this.redis.set(redisKey, stringifiedData, 'EX', 2 * 24 * 60 * 60);
        this.logger.log(`Saved cache to Redis for URL: ${instagramUrl}`);
      } catch (err) {
        this.logger.warn(`Failed to save cache to Redis: ${err.message}`);
      }
    }
  }

  async clearCache(): Promise<void> {
    if (this.db) {
      try {
        await this.db.run('DELETE FROM instagram_cache');
        this.logger.log('SQLite database cache successfully cleared.');
      } catch (err) {
        this.logger.error(`Failed to clear SQLite cache: ${err.message}`);
      }
    }

    if (this.redis) {
      try {
        const keys = await this.redis.keys('ig_cache:*');
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
        this.logger.log('Redis cache successfully cleared.');
      } catch (err) {
        this.logger.warn(`Failed to clear Redis cache: ${err.message}`);
      }
    }
  }
}
