import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as http from 'http';
import * as https from 'https';
import * as dns from 'dns';
import { PassThrough } from 'stream';

import { instagram as jerryInstagram } from '@jerrycoder/instagram-api';
import { igdl } from 'btch-downloader';

// Force Cloudflare and Google DNS resolution for high speed and low latency
try {
  dns.setServers(['1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4']);
} catch (err) {
  // Silent fallback if environment prevents DNS server modifications
}

// In-memory DNS cache to bypass blocking synchronous 'getaddrinfo' lookups
const dnsCache = new Map<string, { address: string; family: number; expires: number }>();
const DNS_TTL = 30 * 60 * 1000; // 30-minute DNS cache TTL

function customDnsLookup(
  hostname: string,
  options: any,
  callback?: (err: NodeJS.ErrnoException | null, address: any, family: any) => void
) {
  const cb = typeof options === 'function' ? options : callback;
  if (!cb) return;

  const opts = typeof options === 'object' ? options : {};
  const reqFamily = typeof options === 'number' ? options : (opts.family || 0);

  const now = Date.now();
  const cacheKey = `${hostname}:${reqFamily}`;
  const cached = dnsCache.get(cacheKey);
  if (cached && cached.expires > now) {
    return cb(null, cached.address, cached.family);
  }

  if (reqFamily === 6) {
    // Handle IPv6 resolution requests
    dns.resolve6(hostname, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        return (dns.lookup as any)(hostname, { ...opts, family: 6 }, (lookupErr: any, address: any, family: any) => {
          if (lookupErr) return cb(lookupErr, null, null);
          dnsCache.set(cacheKey, { address, family, expires: Date.now() + 5000 });
          cb(null, address, family);
        });
      }
      const address = addresses[0];
      dnsCache.set(cacheKey, { address, family: 6, expires: now + DNS_TTL });
      cb(null, address, 6);
    });
  } else {
    // Default to IPv4 resolution (resolve4) for family 4 or 0 (any)
    dns.resolve4(hostname, (err, addresses) => {
      if (err || !addresses || addresses.length === 0) {
        return (dns.lookup as any)(hostname, { ...opts, family: 4 }, (lookupErr: any, address: any, family: any) => {
          if (lookupErr) return cb(lookupErr, null, null);
          dnsCache.set(cacheKey, { address, family, expires: Date.now() + 5000 });
          cb(null, address, family);
        });
      }
      const address = addresses[0];
      dnsCache.set(cacheKey, { address, family: 4, expires: now + DNS_TTL });
      cb(null, address, 4);
    });
  }
}

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

  // High performance TCP Keep-Alive Agents forcing IPv4 (family: 4)
  private readonly httpAgent = new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000, // TCP Keep-Alive delay set to 1 second
    family: 4,            // Force IPv4 locally to speed up connection handshakes
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 15000,
    scheduling: 'fifo',
    noDelay: true,        // Disable Nagle's TCP algorithm to send packets instantly
    lookup: customDnsLookup,
  });

  private readonly httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 1000, // TCP Keep-Alive delay set to 1 second
    family: 4,            // Force IPv4
    maxSockets: 100,
    maxFreeSockets: 10,
    timeout: 15000,
    scheduling: 'fifo',
    noDelay: true,        // Disable Nagle's TCP algorithm
    lookup: customDnsLookup,
  });

  // Proxy rotation state — track last used index per account to avoid hammering one proxy
  private proxyIndex = 0;

  constructor() {
    // Apply keep-alive agents globally to Axios instance defaults
    axios.defaults.httpAgent = this.httpAgent;
    axios.defaults.httpsAgent = this.httpsAgent;
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
    // 1. Request Interceptor: Attach proxy to specific target hosts
    axios.interceptors.request.use((config) => {
      let isInstagramScrape = false;
      let isBtchScrape = false;
      let isJerryCoder = false;

      if (config.url) {
        try {
          const parsed = new URL(config.url);
          // Target 1: Direct Instagram scraping (just in case)
          isInstagramScrape =
            (parsed.hostname === 'instagram.com' || parsed.hostname === 'www.instagram.com') &&
            !config.url.includes('scontent') &&
            config.responseType !== 'stream' &&
            config.responseType !== 'arraybuffer';

          // Target 2: btch-downloader backend (tioo.eu.org)
          isBtchScrape = parsed.hostname.includes('tioo.eu.org');

          // Target 3: JerryCoder API workers
          isJerryCoder = parsed.hostname.includes('jerrycoder.oggyapi.workers.dev');
        } catch (_) {
          isInstagramScrape =
            config.url.includes('instagram.com') &&
            !config.url.includes('jerrycoder.oggyapi.workers.dev') &&
            !config.url.includes('scontent') &&
            config.responseType !== 'stream' &&
            config.responseType !== 'arraybuffer';

          isBtchScrape = config.url.includes('tioo.eu.org');
          isJerryCoder = config.url.includes('jerrycoder.oggyapi.workers.dev');
        }
      }

      const shouldProxy = (isInstagramScrape || isBtchScrape || isJerryCoder) && !config.proxy && !(config as any).skipInterceptor;

      if (shouldProxy) {
        const p = this.getNextProxy();
        config.proxy = {
          host: p.host,
          port: p.port,
          auth: p.username ? { username: p.username, password: p.password } : undefined,
        };
        (config as any).__isProxiedRequest = true;
        this.logger.log(`[Interceptor] Routing ${config.url} via proxy ${p.host}:${p.port}`);
      }
      return config;
    });

    // 2. Response Interceptor: Catch failures (timeout, bad proxy, 500, etc.) and retry with a new proxy
    axios.interceptors.response.use(
      (response) => response,
      async (error) => {
        const config = error.config;
        if (!config) {
          return Promise.reject(error);
        }

        // Initialize retry counter
        config.__retryCount = config.__retryCount || 0;
        const maxRetries = 3;

        // Check if we can retry
        const isJerryCoder = config.url?.includes('jerrycoder.oggyapi.workers.dev');
        const isProxied = (config as any).__isProxiedRequest;

        if ((isProxied || isJerryCoder) && config.__retryCount < maxRetries) {
          config.__retryCount += 1;

          if (isProxied) {
            // Rotate to a new proxy for the retry
            const p = this.getNextProxy();
            config.proxy = {
              host: p.host,
              port: p.port,
              auth: p.username ? { username: p.username, password: p.password } : undefined,
            };
            this.logger.warn(
              `[Interceptor Retry] Proxied request to ${config.url} failed (${error.message}). ` +
              `Retrying (${config.__retryCount}/${maxRetries}) using new proxy ${p.host}:${p.port}...`
            );
          } else if (isJerryCoder) {
            // Wait 1.5 seconds before retrying JerryCoder API directly
            this.logger.warn(
              `[Interceptor Retry] JerryCoder API to ${config.url} failed (${error.message}). ` +
              `Retrying (${config.__retryCount}/${maxRetries}) after 1.5s...`
            );
            await new Promise((resolve) => setTimeout(resolve, 1500));
          }

          // Re-execute request with updated config
          return axios(config);
        }

        return Promise.reject(error);
      }
    );
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

      // ── Scraper 1: JerryCoder API (Primary & Fastest) ──
      (async () => {
        try {
          const data = await jerryInstagram(normalized);
          if (!data || !data.url) throw new Error('jerrycoder-api: empty result');

          const directUrl = this.extractDirectUrl(data.url);
          const isVideo = data.type === 'video' || directUrl.includes('.mp4') || directUrl.toLowerCase().includes('video');

          this.logger.log(`[Race] jerrycoder-api won!`);
          return {
            results_number: 1,
            url_list: [directUrl],
            media_details: [{
              type: isVideo ? 'video' : 'image',
              url: directUrl,
              thumbnail: data.thumbnail
            }]
          };
        } catch (err: any) {
          this.logger.warn(`[Race] jerrycoder-api failed: ${err.message}`);
          throw err;
        }
      })(),

      // ── Scraper 2: btch-downloader (Secondary / Fallback) ──
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

  private optimizeStream(rawStream: any): any {
    const pass = new PassThrough({ highWaterMark: 1024 * 1024 }); // 1 MB buffer size
    rawStream.pipe(pass);
    return pass;
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
          stream: this.optimizeStream(res.data),
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
        stream: this.optimizeStream(res.data),
        mimeType: (res.headers['content-type'] as string) || 'video/mp4',
        contentLength: res.headers['content-length'] as string,
      };
    } catch (err) {
      this.logger.warn(`[Stream] Proxy failed: ${err.message}. Last resort direct...`);
    }

    // Last resort: direct again without timeout
    const res = await axios.get(url, this.withDirect({ responseType: 'stream', headers }));
    return {
      stream: this.optimizeStream(res.data),
      mimeType: (res.headers['content-type'] as string) || 'video/mp4',
      contentLength: res.headers['content-length'] as string,
    };
  }
}
