import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as http from 'http';
import * as https from 'https';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { instagramGetUrl } = require('instagram-url-direct');

// Import btch-downloader igdl function
import { igdl } from 'btch-downloader';

export interface MediaDetail {
  type: 'video' | 'image';
  dimensions?: {
    height: string;
    width: string;
  };
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
  username?: string;
  password?: string;
}

@Injectable()
export class InstagramService {
  private readonly logger = new Logger(InstagramService.name);

  // --- KEEP-ALIVE CONNECTION AGENTS ---
  // Reuses TCP/TLS handshakes to save 100ms - 300ms on every HTTP request
  private readonly httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
  private readonly httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

  // --- API & COOKIE ROTATION CONFIGURATION ---
  private readonly apiUrls = [
    'https://api1.myapp.com',
    'https://api2.myapp.com',
    // ... Add your 10 API endpoints here
  ];

  private readonly cookies = [
    'session=abc001',
    'session=abc002',
    // ... Add your 30 Instagram session cookies here
  ];

  private readonly MAX_PER_COOKIE = 7;
  private readonly usageCount = new Map<string, number>();

  /**
   * Parses the PROXY_POOL env variable or falls back to the 10 proxies from the screenshot.
   * Supports formats:
   * 1. host:port (uses default PROXY_USERNAME and PROXY_PASSWORD)
   * 2. username:password@host:port (uses specific credentials)
   */
  private getProxyList(): ProxyDetails[] {
    const envPool = process.env.PROXY_POOL;
    if (envPool) {
      try {
        return envPool.split(',').map(item => {
          const cleanItem = item.trim();
          if (cleanItem.includes('@')) {
            const [credentials, address] = cleanItem.split('@');
            const [username, password] = credentials.split(':');
            const [host, port] = address.split(':');
            return {
              host: host.trim(),
              port: parseInt(port.trim(), 10),
              username: username.trim(),
              password: password.trim(),
            };
          } else {
            const [host, port] = cleanItem.split(':');
            return {
              host: host.trim(),
              port: parseInt(port.trim(), 10),
            };
          }
        });
      } catch (err) {
        this.logger.warn(`Failed to parse PROXY_POOL: ${err.message}. Using default pool.`);
      }
    }

    // Default Webshare 10 free proxies pool from the user's screenshot
    return [
      { host: '31.59.20.176', port: 6754 },
      { host: '31.56.127.193', port: 7684 },
      { host: '45.38.107.97', port: 6014 },
      { host: '38.154.203.95', port: 5863 },
      { host: '198.105.121.200', port: 6462 },
      { host: '64.137.96.74', port: 6641 },
      { host: '198.23.243.226', port: 6361 },
      { host: '38.154.185.97', port: 6370 },
      { host: '142.111.67.146', port: 5611 },
      { host: '191.96.254.138', port: 6185 }
    ];
  }

  /**
   * Helper to construct Axios request options with rotated proxy support (used for scraping/API calls).
   */
  private getAxiosConfig(options: any = {}): any {
    const proxies = this.getProxyList();
    const defaultUser = process.env.PROXY_USERNAME || 'vyrysnub';
    const defaultPass = process.env.PROXY_PASSWORD || 'm2taxn81eypu';

    const config: any = { ...options };

    if (proxies.length > 0) {
      // Pick a random proxy from the list for rotation
      const selected = proxies[Math.floor(Math.random() * proxies.length)];
      const username = selected.username || defaultUser;
      const password = selected.password || defaultPass;

      config.proxy = {
        host: selected.host,
        port: selected.port,
      };

      if (username && password) {
        config.proxy.auth = {
          username,
          password,
        };
      }
      this.logger.log(`Routing request through rotated proxy IP: ${selected.host}:${selected.port}`);
    }

    return config;
  }

  /**
   * Helper to construct Axios request options WITHOUT proxy (used for downloading direct CDN URLs at maximum local speed).
   * Employs keep-alive agents to reuse TCP connections.
   */
  private getDirectAxiosConfig(options: any = {}): any {
    return {
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      ...options,
    };
  }

  /**
   * Decodes JWT token parameters from proxy CDN URLs to extract the direct public Meta CDN URL.
   */
  extractDirectUrl(url: string): string {
    try {
      if (url && url.includes('token=')) {
        const urlObj = new URL(url);
        const token = urlObj.searchParams.get('token');
        if (token) {
          const parts = token.split('.');
          if (parts.length >= 2) {
            const payloadBase64 = parts[1];
            const normalizedBase64 = payloadBase64.replace(/-/g, '+').replace(/_/g, '/');
            const padLen = (4 - (normalizedBase64.length % 4)) % 4;
            const paddedBase64 = normalizedBase64 + '='.repeat(padLen);
            const jsonStr = Buffer.from(paddedBase64, 'base64').toString('utf8');
            
            // Sanitize raw control characters (codes 0-31) in the JSON string
            const sanitizedStr = jsonStr.replace(/[\x00-\x1F\x7F-\x9F]/g, (char) => {
              if (char === '\n') return '\\n';
              if (char === '\r') return '\\r';
              if (char === '\t') return '\\t';
              return '';
            });

            const payload = JSON.parse(sanitizedStr);
            if (payload && payload.url) {
              this.logger.log('Successfully decoded direct Meta CDN URL from token');
              return payload.url;
            }
          }
        }
      }
    } catch (err) {
      this.logger.warn(`Failed to extract direct URL from token: ${err.message}`);
    }
    return url || '';
  }

  /**
   * Simple weighted/random shuffle implementation.
   */
  getWeightedShuffled<T>(array: T[]): T[] {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  /**
   * Sends request to a rotated API URL using a rotated Cookie.
   */
  private async sendRotatedRequest(
    apiUrl: string,
    cookie: string,
    instagramUrl: string,
    retryCount = 0,
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    try {
      this.logger.log(`[Rotator] Sending to ${apiUrl} using cookie hash (${cookie.substring(0, 15)}...)`);
      
      const axiosConfig = this.getAxiosConfig({
        params: { url: instagramUrl },
        headers: { Cookie: cookie },
        timeout: 5000,
      });

      const response = await axios.get(`${apiUrl}/endpoint`, axiosConfig);
      return { success: true, data: response.data };
    } catch (err: any) {
      const status = err?.response?.status;
      this.logger.warn(`[Rotator] API ${apiUrl} failed with status ${status}: ${err.message}`);

      if (status === 429 && retryCount < 3) {
        // Exponential backoff
        await new Promise(r => setTimeout(r, 500 * (retryCount + 1)));
        return this.sendRotatedRequest(apiUrl, cookie, instagramUrl, retryCount + 1);
      }

      return { success: false, error: `${status ?? 'network'}: ${err.message}` };
    }
  }

  /**
   * Helper to dynamically parse diverse response formats from custom APIs.
   */
  private parseCustomApiResponse(data: any): InstagramMediaResponse | null {
    if (!data) return null;

    if (data.url_list || data.media_details) {
      return data as InstagramMediaResponse;
    }

    if (Array.isArray(data.result)) {
      // Filter out items with empty or invalid URLs
      const validItems = data.result.filter((item: any) => {
        const u = item.url || item;
        return typeof u === 'string' && u.trim() !== '';
      });

      if (validItems.length === 0) return null;

      const urlList = validItems.map((item: any) => this.extractDirectUrl(item.url || item));
      const mediaDetails = validItems.map((item: any) => {
        const directUrl = this.extractDirectUrl(item.url || item);
        const isVideo = directUrl.includes('.mp4') || directUrl.toLowerCase().includes('video') || directUrl.includes('&mime=video');
        return {
          type: (isVideo ? 'video' : 'image') as 'video' | 'image',
          url: directUrl,
          thumbnail: item.thumbnail,
          filename: item.filename,
        };
      });

      return {
        results_number: urlList.length,
        url_list: urlList,
        media_details: mediaDetails,
      };
    }

    const singleUrl = data.url || data.videoUrl || data.downloadUrl || data.video;
    if (typeof singleUrl === 'string' && singleUrl.trim() !== '') {
      const directUrl = this.extractDirectUrl(singleUrl);
      const isVideo = directUrl.includes('.mp4') || directUrl.toLowerCase().includes('video') || directUrl.includes('&mime=video');
      return {
        results_number: 1,
        url_list: [directUrl],
        media_details: [{
          type: isVideo ? 'video' : 'image',
          url: directUrl,
        }],
      };
    }

    return null;
  }

  /**
   * Checks if a string is a valid Instagram media URL.
   */
  isValidUrl(url: string): boolean {
    if (!url) return false;
    const regex = /https?:\/\/(www\.)?instagram\.com\/(p|reel|tv|reels)\/([A-Za-z0-9_-]+)/i;
    return regex.test(url);
  }

  /**
   * Normalizes the Instagram URL.
   */
  normalizeUrl(url: string): string {
    const match = url.match(/(https?:\/\/(www\.)?instagram\.com\/(p|reel|tv|reels)\/[A-Za-z0-9_-]+)/i);
    return match ? match[1] + '/' : url;
  }

  /**
   * Fetches direct CDN URLs using load-balancing rotation, with fallbacks to other scrapers.
   * Optimizes scraping speed by executing all fallback scrapers concurrently using Promise.any.
   */
  async getMediaUrls(url: string): Promise<InstagramMediaResponse> {
    const normalized = this.normalizeUrl(url);
    
    // --- METHOD 0: Custom API & Cookie Rotation ---
    if (this.apiUrls.length > 0 && this.cookies.length > 0 && !this.apiUrls[0].includes('api1.myapp.com')) {
      try {
        this.logger.log('[Rotator] Initializing rotation run...');
        const shuffledApis = this.getWeightedShuffled(this.apiUrls);
        const shuffledCookies = this.getWeightedShuffled(this.cookies);

        const api = shuffledApis[0];
        const cookie = shuffledCookies[0];

        // Track usage
        this.usageCount.set(api, (this.usageCount.get(api) ?? 0) + 1);
        this.usageCount.set(cookie, (this.usageCount.get(cookie) ?? 0) + 1);

        // Add organic random delay (0ms - 1000ms)
        const delay = Math.random() * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));

        const response = await this.sendRotatedRequest(api, cookie, normalized);
        if (response.success && response.data) {
          const parsed = this.parseCustomApiResponse(response.data);
          if (parsed) {
            this.logger.log('[Rotator] Custom API rotation succeeded!');
            return parsed;
          }
        }
      } catch (rotationErr) {
        this.logger.warn(`[Rotator] Rotation cycle failed: ${rotationErr.message}. Falling back to standard scrapers...`);
      }
    }

    // --- CONCURRENT SCRAPING RACE ENGINE ---
    this.logger.log('Launching concurrent scraper race (btch-downloader & instagram-url-direct)...');

    const scraperPromises = [
      // Scraper Task 1: btch-downloader
      (async () => {
        try {
          const data = await igdl(normalized);
          if (data && data.result && data.result.length > 0) {
            const validResults = data.result.filter(item => item.url && typeof item.url === 'string' && item.url.trim() !== '');
            if (validResults.length > 0) {
              const urlList = validResults.map(item => this.extractDirectUrl(item.url));
              const mediaDetails = validResults.map(item => {
                const directUrl = this.extractDirectUrl(item.url);
                const isVideo = directUrl.includes('.mp4') || directUrl.toLowerCase().includes('video') || directUrl.includes('&mime=video');
                return {
                  type: (isVideo ? 'video' : 'image') as 'video' | 'image',
                  url: directUrl,
                  thumbnail: item.thumbnail,
                  filename: (item as any).filename,
                };
              });
              this.logger.log('Race Winner: btch-downloader succeeded first!');
              return {
                results_number: validResults.length,
                url_list: urlList,
                media_details: mediaDetails,
              };
            }
          }
          throw new Error('btch-downloader returned empty results');
        } catch (err) {
          this.logger.warn(`btch-downloader task in race failed: ${err.message}`);
          throw err;
        }
      })(),

      // Scraper Task 2: instagram-url-direct
      (async () => {
        try {
          const data = await instagramGetUrl(normalized);
          if (data && (data.url_list || data.media_details)) {
            const rawUrls = data.url_list || [];
            const urlList = rawUrls.filter((u: string) => u && typeof u === 'string' && u.trim() !== '').map((u: string) => this.extractDirectUrl(u));
            const mediaDetails = data.media_details || urlList.map((mediaUrl: string) => {
              const directUrl = this.extractDirectUrl(mediaUrl);
              const isVideo = directUrl.includes('.mp4') || directUrl.toLowerCase().includes('video') || directUrl.includes('&mime=video');
              return {
                type: isVideo ? 'video' : 'image',
                url: directUrl,
              };
            });

            if (urlList.length > 0 || mediaDetails.length > 0) {
              this.logger.log('Race Winner: instagram-url-direct succeeded first!');
              return {
                results_number: urlList.length || mediaDetails.length,
                url_list: urlList,
                media_details: mediaDetails,
              };
            }
          }
          throw new Error('instagram-url-direct returned empty results');
        } catch (err) {
          this.logger.warn(`instagram-url-direct task in race failed: ${err.message}`);
          throw err;
        }
      })()
    ];

    try {
      const fastResult = await Promise.any(scraperPromises);
      return fastResult;
    } catch (error) {
      this.logger.error(`All concurrent scrapers failed for URL (${url})`);
      throw new Error('Instagram videoni yuklab bo\'lmadi. Bu video shaxsiy (private) akkauntdan olingan bo\'lishi, o\'chirilgan bo\'lishi yoki tizimda yuklanish ko\'pligi sababli bo\'lishi mumkin.');
    }
  }

  /**
   * Downloads the media buffer from the direct CDN link.
   * Employs a dual-pipeline with Keep-Alive connection agents and diagnostic timing metrics.
   */
  async downloadMedia(url: string): Promise<{ data: Buffer; mimeType: string }> {
    if (!url || typeof url !== 'string' || url.trim() === '') {
      throw new Error('Invalid download URL provided');
    }

    const startDownload = Date.now();
    const bypassDirect = process.env.BYPASS_DIRECT_DOWNLOAD === 'true';
    
    if (!bypassDirect) {
      // --- ROUTE A: Direct first (with 4s timeout), then Proxy ---
      try {
        this.logger.log(`Attempting direct media download (no proxy) with 4s timeout...`);
        const axiosConfig = this.getDirectAxiosConfig({
          responseType: 'arraybuffer',
          timeout: 4000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
          },
        });

        const response = await axios.get(url, axiosConfig);
        const mimeType = (response.headers['content-type'] as string) || 'video/mp4';
        this.logger.log(`Direct media download succeeded in ${Date.now() - startDownload}ms!`);
        return { data: Buffer.from(response.data), mimeType };
      } catch (error) {
        this.logger.warn(`Direct media download failed in ${Date.now() - startDownload}ms: ${error.message}. Switching to rotated proxy...`);
        
        try {
          const startProxy = Date.now();
          const axiosConfig = this.getAxiosConfig({
            responseType: 'arraybuffer',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': '*/*',
              'Accept-Encoding': 'gzip, deflate, br',
              'Connection': 'keep-alive',
            },
          });
          const response = await axios.get(url, axiosConfig);
          const mimeType = (response.headers['content-type'] as string) || 'video/mp4';
          this.logger.log(`Proxy media download succeeded in ${Date.now() - startProxy}ms!`);
          return { data: Buffer.from(response.data), mimeType };
        } catch (proxyError) {
          this.logger.error(`Both direct and proxy media downloads failed: ${proxyError.message}`);
          throw new Error('Could not download the video stream from Instagram servers.');
        }
      }
    } else {
      // --- ROUTE B: Proxy first, then Direct as last resort (handles large files if proxy limits them) ---
      try {
        const startProxy = Date.now();
        this.logger.log(`Attempting proxy media download...`);
        const axiosConfig = this.getAxiosConfig({
          responseType: 'arraybuffer',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
          },
        });
        const response = await axios.get(url, axiosConfig);
        const mimeType = (response.headers['content-type'] as string) || 'video/mp4';
        this.logger.log(`Proxy media download succeeded in ${Date.now() - startProxy}ms!`);
        return { data: Buffer.from(response.data), mimeType };
      } catch (proxyError) {
        this.logger.warn(`Proxy media download failed: ${proxyError.message}. Trying direct download (no proxy) as a last resort...`);
        
        try {
          const startLastResort = Date.now();
          const axiosConfig = this.getDirectAxiosConfig({
            responseType: 'arraybuffer',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': '*/*',
              'Accept-Encoding': 'gzip, deflate, br',
              'Connection': 'keep-alive',
            },
          });
          const response = await axios.get(url, axiosConfig);
          const mimeType = (response.headers['content-type'] as string) || 'video/mp4';
          this.logger.log(`Last-resort direct media download succeeded in ${Date.now() - startLastResort}ms!`);
          return { data: Buffer.from(response.data), mimeType };
        } catch (directError) {
          this.logger.error(`Both proxy and last-resort direct media downloads failed: ${directError.message}`);
          throw new Error('Could not download the video stream from Instagram servers.');
        }
      }
    }
  }

  /**
   * Opens a direct readable stream from the Instagram CDN.
   * Employs a dual-pipeline with Keep-Alive connection agents, content-length exposure, and diagnostic timing metrics.
   */
  async downloadMediaStream(url: string): Promise<{ stream: any; mimeType: string; contentLength?: string }> {
    if (!url || typeof url !== 'string' || url.trim() === '') {
      throw new Error('Invalid streaming URL provided');
    }

    const startDownload = Date.now();
    const bypassDirect = process.env.BYPASS_DIRECT_DOWNLOAD === 'true';

    if (!bypassDirect) {
      // --- ROUTE A: Direct first (with 4s timeout), then Proxy ---
      try {
        this.logger.log(`Attempting direct download stream (no proxy) with 4s timeout...`);
        const axiosConfig = this.getDirectAxiosConfig({
          responseType: 'stream',
          timeout: 4000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
          },
        });

        const response = await axios.get(url, axiosConfig);
        const mimeType = (response.headers['content-type'] as string) || 'video/mp4';
        const contentLength = response.headers['content-length'] as string;
        
        this.logger.log(`Instagram CDN connected (Direct). Headers received in ${Date.now() - startDownload}ms`);
        
        response.data.on('end', () => {
          this.logger.log(`Instagram CDN stream completed (Direct) in ${Date.now() - startDownload}ms`);
        });

        return { stream: response.data, mimeType, contentLength };
      } catch (error) {
        this.logger.warn(`Direct download stream failed or timed out in ${Date.now() - startDownload}ms: ${error.message}. Switching to rotated proxy...`);
      }
    }

    // --- ROUTE B/FALLBACK: Proxy first, then Direct as last resort ---
    const startProxy = Date.now();
    try {
      this.logger.log(`Attempting proxy download stream...`);
      const axiosConfig = this.getAxiosConfig({
        responseType: 'stream',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
        },
      });

      const response = await axios.get(url, axiosConfig);
      const mimeType = (response.headers['content-type'] as string) || 'video/mp4';
      const contentLength = response.headers['content-length'] as string;
      
      this.logger.log(`Instagram CDN connected (Proxy). Headers received in ${Date.now() - startProxy}ms`);
      
      response.data.on('end', () => {
        this.logger.log(`Instagram CDN stream completed (Proxy) in ${Date.now() - startProxy}ms`);
      });

      return { stream: response.data, mimeType, contentLength };
    } catch (proxyError) {
      this.logger.warn(`Proxy download stream failed in ${Date.now() - startProxy}ms: ${proxyError.message}. Trying direct download (no proxy) as a last resort...`);
      
      const startLastResort = Date.now();
      try {
        const axiosConfig = this.getDirectAxiosConfig({
          responseType: 'stream',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
          },
        });

        const response = await axios.get(url, axiosConfig);
        const mimeType = (response.headers['content-type'] as string) || 'video/mp4';
        const contentLength = response.headers['content-length'] as string;
        
        this.logger.log(`Instagram CDN connected (Last Resort). Headers received in ${Date.now() - startLastResort}ms`);
        
        response.data.on('end', () => {
          this.logger.log(`Instagram CDN stream completed (Last Resort) in ${Date.now() - startLastResort}ms`);
        });

        return { stream: response.data, mimeType, contentLength };
      } catch (directError) {
        this.logger.error(`Both proxy and last-resort direct downloads failed: ${directError.message}`);
        throw new Error('Could not open download stream from Instagram servers.');
      }
    }
  }
}
