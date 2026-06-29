import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private pool: Pool;

  constructor(private readonly configService: ConfigService) {}

  /**
   * Helper to parse the connection string, returning the default 'postgres' db connection URL
   * and the target database name.
   */
  private getPostgresDefaultUrl(connectionString: string): { defaultUrl: string; dbName: string } {
    try {
      const urlObj = new URL(connectionString);
      const dbName = urlObj.pathname.substring(1) || 'postgres';
      urlObj.pathname = '/postgres';
      return { defaultUrl: urlObj.toString(), dbName };
    } catch (err) {
      this.logger.warn(`Failed to parse connection string URL: ${err.message}`);
      return { defaultUrl: connectionString, dbName: 'postgres' };
    }
  }

  async onModuleInit() {
    const connectionString = this.configService.get<string>('DATABASE_URL');
    if (!connectionString) {
      this.logger.error('DATABASE_URL is not defined in .env!');
      return;
    }

    const { defaultUrl, dbName } = this.getPostgresDefaultUrl(connectionString);

    // --- AUTOMATIC DATABASE CREATION ---
    if (dbName !== 'postgres') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Client } = require('pg');
        const client = new Client({ connectionString: defaultUrl });
        await client.connect();

        const checkRes = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
        if (checkRes.rows.length === 0) {
          this.logger.log(`Database "${dbName}" does not exist. Attempting to create it automatically...`);
          await client.query(`CREATE DATABASE "${dbName}"`);
          this.logger.log(`Database "${dbName}" successfully created!`);
        }
        await client.end();
      } catch (dbCreateErr) {
        this.logger.warn(`Failed to verify/create database "${dbName}" automatically: ${dbCreateErr.message}`);
      }
    }

    // Now connect to the target database pool
    this.pool = new Pool({
      connectionString,
    });

    try {
      // Connect to verify credentials and DB existence
      const client = await this.pool.connect();
      this.logger.log(`Successfully connected to PostgreSQL database: "${dbName}"!`);
      client.release();

      // Initialize cache table
      await this.initSchema();
    } catch (err) {
      this.logger.error(`PostgreSQL Connection failed to database "${dbName}": ${err.message}`);
      this.logger.warn('Please make sure your database credentials and connection parameters are correct.');
    }
  }

  async onModuleDestroy() {
    if (this.pool) {
      await this.pool.end();
      this.logger.log('PostgreSQL connection pool closed.');
    }
  }

  private async initSchema() {
    const query = `
      CREATE TABLE IF NOT EXISTS instagram_cache (
        instagram_url TEXT PRIMARY KEY,
        media_data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    try {
      await this.pool.query(query);
      this.logger.log('Database cache table initialized/verified.');
    } catch (err) {
      this.logger.error(`Failed to initialize database schema: ${err.message}`);
    }
  }

  async getCache(instagramUrl: string): Promise<any[] | null> {
    if (!this.pool) return null;
    const query = 'SELECT media_data FROM instagram_cache WHERE instagram_url = $1';
    try {
      const res = await this.pool.query(query, [instagramUrl]);
      if (res.rows.length > 0) {
        return res.rows[0].media_data;
      }
    } catch (err) {
      this.logger.error(`Error querying cache from PostgreSQL: ${err.message}`);
    }
    return null;
  }

  async setCache(instagramUrl: string, mediaData: any[]): Promise<void> {
    if (!this.pool) return;
    const query = `
      INSERT INTO instagram_cache (instagram_url, media_data)
      VALUES ($1, $2)
      ON CONFLICT (instagram_url)
      DO UPDATE SET media_data = EXCLUDED.media_data, created_at = CURRENT_TIMESTAMP;
    `;
    try {
      await this.pool.query(query, [instagramUrl, JSON.stringify(mediaData)]);
      this.logger.log(`Saved cache to PostgreSQL for URL: ${instagramUrl}`);
    } catch (err) {
      this.logger.error(`Error saving cache to PostgreSQL: ${err.message}`);
    }
  }
}
