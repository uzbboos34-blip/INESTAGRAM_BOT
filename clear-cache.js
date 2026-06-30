const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const Redis = require('ioredis');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

async function run() {
  console.log('Clearing local cache...');

  // 1. Clear SQLite
  const dbFile = process.env.DATABASE_FILE || 'database.db';
  const dbPath = path.isAbsolute(dbFile) ? dbFile : path.join(process.cwd(), dbFile);
  try {
    const db = await open({ filename: dbPath, driver: sqlite3.Database });
    await db.run('DELETE FROM instagram_cache');
    await db.close();
    console.log('SQLite database cache successfully cleared!');
  } catch (err) {
    console.log('SQLite clear failed (might not exist yet):', err.message);
  }

  // 2. Clear Redis
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const redis = new Redis(redisUrl);
      const keys = await redis.keys('ig_cache:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
      await redis.quit();
      console.log('Redis cache successfully cleared!');
    } catch (err) {
      console.log('Redis clear failed:', err.message);
    }
  } else {
    console.log('Redis URL not configured in .env, skipped Redis cache clearing.');
  }
}

run();
