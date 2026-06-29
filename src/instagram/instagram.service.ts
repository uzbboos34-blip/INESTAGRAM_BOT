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
  private readonly httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
  private readonly httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

  // --- API & COOKIE ROTATION CONFIGURATION ---
  private readonly apiUrls = [
    'https://api1.myapp.com',
    'https://api2.myapp.com',
  ];

  private readonly cookies = [
    'session=abc001',
    'session=abc002',
  ];

  private readonly usageCount = new Map<string, number>();

  constructor() {
    // --- GLOBAL AXIOS REQUEST INTERCEPTOR ---
    // Intercepts and routes scraping requests from third-party libraries (like instagram-url-direct)
    // through our rotated proxy pool to prevent Render's datacenter IP from getting banned by Instagram.
    axios.interceptors.request.use(
      (config) => {
        const isScrapingRequest =
          config.url &&
          config.url.includes('instagram.com') &&
          !config.url.includes('scontent') && // Ignore media downloads
          config.responseType !== 'stream' &&
          config.responseType !== 'arraybuffer' &&
          !config.proxy; // Only apply if proxy is not already set

        if (isScrapingRequest) {
          const proxies = this.getProxyList();
          if (proxies.length > 0) {
            const selected = proxies[Math.floor(Math.random() * proxies.length)];
            const defaultUser = process.env.PROXY_USERNAME || 'vyrysnub';
            const defaultPass = process.env.PROXY_PASSWORD || 'm2taxn81eypu';

            config.proxy = {
              host: selected.host,
              port: selected.port,
            };

            if (defaultUser && defaultPass) {
              config.proxy.auth = {
                username: defaultUser,
                password: defaultPass,
              };
            }
            this.logger.log(`[Axios Interceptor] Routed third-party scraping request to ${config.url} via proxy ${selected.host}`);
          }
        }
        return config;
      },
      (error) => {
        return Promise.reject(error);
      }
    );
  }

  /**
   * Parses the PROXY_POOL env variable or falls back to the default list.
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

  private getAxiosConfig(options: any = {}): any {
    const proxies = this.getProxyList();
    const defaultUser = process.env.PROXY_USERNAME || 'vyrysnub';
    const defaultPass = process.env.PROXY_PASSWORD || 'm2taxn81eypu';

    const config: any = { ...options };

    if (proxies.length > 0) {
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
    }

    return config;
  }

  private getDirectAxiosConfig(options: any = {}): any {
    return {
      httpAgent: this.httpAgent,
      httpsAgent: this.httpsAgent,
      ...options,
    };
  }

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
            
            const sanitizedStr = jsonStr.replace(/[\x00-\x1F\x7F-\x9F]/g, (char) => {
              if (char === '\n') return '\\n';
              if (char === '\r') return '\\r';
              if (char === '\t') return '\\t';
              return '';
            });

            const payload = JSON.parse(sanitizedStr);
            if (payload && payload.url) {
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

  getWeightedShuffled<T>(array: T[]): T[] {
    const copy = [...array];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

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
        await new Promise(r => setTimeout(r, 500 * (retryCount + 1)));
        return this.sendRotatedRequest(apiUrl, cookie, instagramUrl, retryCount + 1);
      }

      return { success: false, error: `${status ?? 'network'}: ${err.message}` };
    }
  }

  private parseCustomApiResponse(data: any): InstagramMediaResponse | null {
    if (!data) return null;

    if (data.url_list || data.media_details) {
      return data as InstagramMediaResponse;
    }

    if (Array.isArray(data.result)) {
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

  isValidUrl(url: string): boolean {
    if (!url) return false;
    const regex = /https?:\/\/(www\.)?instagram\.com\/(p|reel|tv|reels)\/([A-Za-z0-9_-]+)/i;
    return regex.test(url);
  }

  normalizeUrl(url: string): string {
    const match = url.match(/(https?:\/\/(www\.)?instagram\.com\/(p|reel|tv|reels)\/[A-Za-z0-9_-]+)/i);
    return match ? match[1] + '/' : url;
  }

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

        this.usageCount.set(api, (this.usageCount.get(api) ?? 0) + 1);
        this.usageCount.set(cookie, (this.usageCount.get(cookie) ?? 0) + 1);

        const delay = Math.random() * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));

        const response = await this.sendRotatedRequest(api, cookie, normalized);
        if (response.success && response.data) {
          const parsed = this.parseCustomApiResponse(response.data);
          if (parsed) {
            return parsed;
          }
        }
      } catch (rotationErr) {
        this.logger.warn(`[Rotator] Rotation cycle failed: ${rotationErr.message}`);
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
              return {
                results_number: validResults.length,
                url_list: urlList,
                media_details: mediaDetails,
              };
            }
          }
          throw new Error('btch-downloader returned empty results');
        } catch (err) {
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
              return {
                results_number: urlList.length || mediaDetails.length,
                url_list: urlList,
                media_details: mediaDetails,
              };
            }
          }
          throw new Error('instagram-url-direct returned empty results');
        } catch (err) {
          throw err;
        }
      })()
    ];

    try {
      return await Promise.any(scraperPromises);
    } catch (error) {
      this.logger.error(`All concurrent scrapers failed for URL (${url})`);
      throw new Error('Instagram videoni yuklab bo\'lmadi. Bu video shaxsiy (private) akkauntdan olingan bo\'lishi, o\'chirilgan bo\'lishi yoki tizimda yuklanish ko\'pligi sababli bo\'lishi mumkin.');
    }
  }

  async downloadMedia(url: string): Promise<{ data: Buffer; mimeType: string }> {
    if (!url || typeof url !== 'string' || url.trim() === '') {
      throw new Error('Invalid download URL provided');
    }

    const startDownload = Date.now();
    const bypassDirect = process.env.BYPASS_DIRECT_DOWNLOAD === 'true';
    
    if (!bypassDirect) {
      try {
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
        return { data: Buffer.from(response.data), mimeType };
      } catch (error) {
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
          return { data: Buffer.from(response.data), mimeType };
        } catch (proxyError) {
          throw new Error('Could not download the video stream from Instagram servers.');
        }
      }
    } else {
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
        return { data: Buffer.from(response.data), mimeType };
      } catch (proxyError) {
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
          return { data: Buffer.from(response.data), mimeType };
        } catch (directError) {
          throw new Error('Could not download the video stream from Instagram servers.');
        }
      }
    }
  }

  async downloadMediaStream(url: string): Promise<{ stream: any; mimeType: string; contentLength?: string }> {
    if (!url || typeof url !== 'string' || url.trim() === '') {
      throw new Error('Invalid streaming URL provided');
    }

    const startDownload = Date.now();
    const bypassDirect = process.env.BYPASS_DIRECT_DOWNLOAD === 'true';

    if (!bypassDirect) {
      try {
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
        
        response.data.on('end', () => {
          this.logger.log(`Instagram CDN stream completed (Direct) in ${Date.now() - startDownload}ms`);
        });

        return { stream: response.data, mimeType, contentLength };
      } catch (error) {
        this.logger.warn(`Direct download stream failed or timed out: ${error.message}. Switching to rotated proxy...`);
      }
    }

    const startProxy = Date.now();
    try {
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
      
      response.data.on('end', () => {
        this.logger.log(`Instagram CDN stream completed (Proxy) in ${Date.now() - startProxy}ms`);
      });

      return { stream: response.data, mimeType, contentLength };
    } catch (proxyError) {
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
        
        response.data.on('end', () => {
          this.logger.log(`Instagram CDN stream completed (Last Resort) in ${Date.now() - startLastResort}ms`);
        });

        return { stream: response.data, mimeType, contentLength };
      } catch (directError) {
        throw new Error('Could not open download stream from Instagram servers.');
      }
    }
  }
}
