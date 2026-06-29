import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as http from 'http';
import * as https from 'https';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { instagramGetUrl } = require('instagram-url-direct');

import { igdl } from 'btch-downloader';

export interface MediaDetail {
  type: 'video' | 'image';
  dimensions?: { height: string; width: string };
  url: string;
  thumbnail?: string;
  filename?: string;
}

export interface InstagramMediaResponse {
  results_number: number;
  url_list: string[];
  media_details?: MediaDetail[];
}

interface ProxyDetails {
  host: string;
  port: number;
  username: string;
  password: string;
}

@Injectable()
export class InstagramService {
  private readonly logger = new Logger(InstagramService.name);

  // Keep-alive agents for direct downloads (CDN media files)
  private readonly httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
  private readonly httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

  // Proxy rotation state — track last used index per account to avoid hammering one proxy
  private proxyIndex = 0;

  constructor() {
    this.setupAxiosInterceptor();
  }

  // ─────────────────────────────────────────────
  // PROXY POOL
  // ─────────────────────────────────────────────

  private getProxyList(): ProxyDetails[] {
    const envPool = process.env.PROXY_POOL;
    if (envPool) {
      try {
        const parsed = envPool.split(',').map(item => {
          const clean = item.trim();
          if (clean.includes('@')) {
            const atIdx = clean.lastIndexOf('@');
            const creds = clean.substring(0, atIdx);
            const addr = clean.substring(atIdx + 1);
            const [username, password] = creds.split(':');
            const [host, portStr] = addr.split(':');
            return { host: host.trim(), port: parseInt(portStr.trim(), 10), username: username.trim(), password: password.trim() };
          } else {
            const [host, portStr] = clean.split(':');
            return { host: host.trim(), port: parseInt(portStr.trim(), 10), username: '', password: '' };
          }
        }).filter(p => p.host && !isNaN(p.port));
        if (parsed.length > 0) return parsed;
      } catch (err) {
        this.logger.warn(`Failed to parse PROXY_POOL env: ${err.message}`);
      }
    }
    // Fallback hardcoded list with correct credentials
    const defaultUser = process.env.PROXY_USERNAME || 'vyrysnub';
    const defaultPass = process.env.PROXY_PASSWORD || 'm2taxn81eypu';
    return [
      { host: '31.59.20.176',    port: 6754, username: defaultUser, password: defaultPass },
      { host: '31.56.127.193',   port: 7684, username: defaultUser, password: defaultPass },
      { host: '45.38.107.97',    port: 6014, username: defaultUser, password: defaultPass },
      { host: '38.154.203.95',   port: 5863, username: defaultUser, password: defaultPass },
      { host: '198.105.121.200', port: 6462, username: defaultUser, password: defaultPass },
      { host: '64.137.96.74',    port: 6641, username: defaultUser, password: defaultPass },
      { host: '198.23.243.226',  port: 6361, username: defaultUser, password: defaultPass },
      { host: '38.154.185.97',   port: 6370, username: defaultUser, password: defaultPass },
      { host: '142.111.67.146',  port: 5611, username: defaultUser, password: defaultPass },
      { host: '191.96.254.138',  port: 6185, username: defaultUser, password: defaultPass },
    ];
  }

  /**
   * Returns the next proxy in round-robin order.
   * Round-robin ensures every proxy gets equal usage — no single proxy gets hammered.
   */
  private getNextProxy(): ProxyDetails {
    const proxies = this.getProxyList();
    const proxy = proxies[this.proxyIndex % proxies.length];
    this.proxyIndex = (this.proxyIndex + 1) % proxies.length;
    return proxy;
  }

  /**
   * Builds an axios config with a rotated proxy attached.
   */
  private withProxy(options: any = {}): any {
    const p = this.getNextProxy();
    this.logger.log(`[Proxy] Using ${p.host}:${p.port} (${p.username})`);
    return {
      ...options,
      proxy: {
        host: p.host,
        port: p.port,
        auth: p.username ? { username: p.username, password: p.password } : undefined,
      },
    };
  }

  /**
   * Builds an axios config for direct downloads (no proxy — CDN media URLs work without it).
   */
  private withDirect(options: any = {}): any {
    return { httpAgent: this.httpAgent, httpsAgent: this.httpsAgent, ...options };
  }

  // ─────────────────────────────────────────────
  // AXIOS INTERCEPTOR
  // Automatically routes all third-party library requests (instagram-url-direct, btch-downloader)
  // through rotating proxies. Uses round-robin so requests spread evenly.
  // ─────────────────────────────────────────────

  private setupAxiosInterceptor() {
    axios.interceptors.request.use((config) => {
      const isInstagramScrape =
        config.url?.includes('instagram.com') &&
        !config.url.includes('scontent') &&          // skip CDN media
        config.responseType !== 'stream' &&
        config.responseType !== 'arraybuffer' &&
        !config.proxy &&                              // only if proxy not already set
        !(config as any).skipInterceptor;             // allow explicit bypass

      if (isInstagramScrape) {
        const p = this.getNextProxy();
        config.proxy = {
          host: p.host,
          port: p.port,
          auth: p.username ? { username: p.username, password: p.password } : undefined,
        };
        this.logger.log(`[Interceptor] ${config.url} → proxy ${p.host}:${p.port}`);
      }
      return config;
    });
  }

  // ─────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────

  isValidUrl(url: string): boolean {
    return /https?:\/\/(www\.)?instagram\.com\/(p|reel|tv|reels)\/[A-Za-z0-9_-]+/i.test(url || '');
  }

  normalizeUrl(url: string): string {
    const match = url.match(/(https?:\/\/(www\.)?instagram\.com\/(p|reel|tv|reels)\/[A-Za-z0-9_-]+)/i);
    return match ? match[1] + '/' : url;
  }

  extractDirectUrl(url: string): string {
    try {
      if (url?.includes('token=')) {
        const token = new URL(url).searchParams.get('token');
        if (token) {
          const parts = token.split('.');
          if (parts.length >= 2) {
            const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
            const raw = Buffer.from(padded, 'base64').toString('utf8');
            const sanitized = raw.replace(/[\x00-\x1F\x7F-\x9F]/g, c =>
              c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : ''
            );
            const payload = JSON.parse(sanitized);
            if (payload?.url) return payload.url;
          }
        }
      }
    } catch (_) { /* ignore */ }
    return url || '';
  }

  // ─────────────────────────────────────────────
  // MAIN SCRAPING FUNCTION
  // Uses Promise.any() — whichever scraper succeeds first wins.
  // Both scrapers run in parallel through rotating proxies (round-robin).
  // ─────────────────────────────────────────────

  async getMediaUrls(url: string): Promise<InstagramMediaResponse> {
    const normalized = this.normalizeUrl(url);
    this.logger.log(`[Race] Starting parallel scrapers for ${normalized}`);

    const scrapers: Promise<InstagramMediaResponse>[] = [

      // ── Scraper 1: btch-downloader ──
      (async () => {
        try {
          const data = await igdl(normalized);
          if (!data?.result?.length) throw new Error('btch-downloader: empty result');

          const valid = data.result.filter(i => i.url && typeof i.url === 'string' && i.url.trim());
          if (!valid.length) throw new Error('btch-downloader: no valid URLs');

          const urlList = valid.map(i => this.extractDirectUrl(i.url));
          const mediaDetails: MediaDetail[] = valid.map(i => {
            const u = this.extractDirectUrl(i.url);
            const isVideo = u.includes('.mp4') || u.toLowerCase().includes('video') || u.includes('&mime=video');
            return { type: isVideo ? 'video' : 'image', url: u, thumbnail: i.thumbnail, filename: (i as any).filename };
          });
          this.logger.log(`[Race] btch-downloader won with ${urlList.length} URL(s)`);
          return { results_number: urlList.length, url_list: urlList, media_details: mediaDetails };
        } catch (err: any) {
          this.logger.warn(`[Race] btch-downloader failed: ${err.message}`);
          throw err;
        }
      })(),

      // ── Scraper 2: instagram-url-direct ──
      (async () => {
        try {
          const data = await instagramGetUrl(normalized);
          if (!data) throw new Error('instagram-url-direct: no data');

          const rawUrls: string[] = (data.url_list || []).filter((u: string) => u?.trim());
          const urlList = rawUrls.map((u: string) => this.extractDirectUrl(u));
          const mediaDetails: MediaDetail[] = (data.media_details || urlList.map((u: string) => {
            const isVideo = u.includes('.mp4') || u.toLowerCase().includes('video');
            return { type: isVideo ? 'video' : 'image', url: u };
          }));

          if (!urlList.length && !mediaDetails.length) throw new Error('instagram-url-direct: empty result');
          this.logger.log(`[Race] instagram-url-direct won with ${urlList.length} URL(s)`);
          return {
            results_number: urlList.length || mediaDetails.length,
            url_list: urlList,
            media_details: mediaDetails,
          };
        } catch (err: any) {
          this.logger.warn(`[Race] instagram-url-direct failed: ${err.message}`);
          throw err;
        }
      })(),
    ];

    try {
      return await Promise.any(scrapers);
    } catch (err: any) {
      this.logger.error(`[Race] All scrapers failed for ${url}`);
      throw new Error("Instagram videoni yuklab bo'lmadi. Bu video shaxsiy (private) akkauntdan olingan bo'lishi, o'chirilgan bo'lishi yoki tizimda yuklanish ko'pligi sababli bo'lishi mumkin.");
    }
  }

  // ─────────────────────────────────────────────
  // DOWNLOAD — Buffer (for small files / images)
  // ─────────────────────────────────────────────

  async downloadMedia(url: string): Promise<{ data: Buffer; mimeType: string }> {
    if (!url?.trim()) throw new Error('Invalid download URL');

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Connection': 'keep-alive',
    };

    // Try direct first (CDN URLs usually work without proxy)
    try {
      const res = await axios.get(url, this.withDirect({ responseType: 'arraybuffer', timeout: 15000, headers }));
      return { data: Buffer.from(res.data), mimeType: (res.headers['content-type'] as string) || 'video/mp4' };
    } catch (err) {
      this.logger.warn(`[Download] Direct failed: ${err.message}. Trying proxy...`);
    }

    // Fallback: proxy
    const res = await axios.get(url, this.withProxy({ responseType: 'arraybuffer', timeout: 20000, headers }));
    return { data: Buffer.from(res.data), mimeType: (res.headers['content-type'] as string) || 'video/mp4' };
  }

  // ─────────────────────────────────────────────
  // DOWNLOAD STREAM — for large video files
  // ─────────────────────────────────────────────

  async downloadMediaStream(url: string): Promise<{ stream: any; mimeType: string; contentLength?: string }> {
    if (!url?.trim()) throw new Error('Invalid streaming URL');

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Connection': 'keep-alive',
    };

    const bypassDirect = process.env.BYPASS_DIRECT_DOWNLOAD === 'true';

    if (!bypassDirect) {
      try {
        const res = await axios.get(url, this.withDirect({ responseType: 'stream', timeout: 8000, headers }));
        return {
          stream: res.data,
          mimeType: (res.headers['content-type'] as string) || 'video/mp4',
          contentLength: res.headers['content-length'] as string,
        };
      } catch (err) {
        this.logger.warn(`[Stream] Direct failed: ${err.message}. Trying proxy...`);
      }
    }

    // Proxy fallback
    try {
      const res = await axios.get(url, this.withProxy({ responseType: 'stream', timeout: 25000, headers }));
      return {
        stream: res.data,
        mimeType: (res.headers['content-type'] as string) || 'video/mp4',
        contentLength: res.headers['content-length'] as string,
      };
    } catch (err) {
      this.logger.warn(`[Stream] Proxy failed: ${err.message}. Last resort direct...`);
    }

    // Last resort: direct again without timeout
    const res = await axios.get(url, this.withDirect({ responseType: 'stream', headers }));
    return {
      stream: res.data,
      mimeType: (res.headers['content-type'] as string) || 'video/mp4',
      contentLength: res.headers['content-length'] as string,
    };
  }
}
