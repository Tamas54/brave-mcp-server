import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import TurndownService from 'turndown';
import * as cheerio from 'cheerio';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Stealth plugin hozzáadása
puppeteer.use(StealthPlugin());

export class BraveController {
  constructor() {
    this.browser = null;
    this.turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-'
    });
    
    // Felesleges elemek eltávolítása
    this.turndownService.remove(['script', 'style', 'nav', 'footer', 'iframe']);
  }

  async initialize() {
    const bravePath = process.env.BRAVE_PATH || this.detectBravePath();
    
    this.browser = await puppeteer.launch({
      executablePath: bravePath,
      headless: process.env.HEADLESS === 'true' ? 'new' : false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=site-per-process',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-dev-shm-usage'
      ]
    });
  }

  detectBravePath() {
    // Platform-specifikus Brave útvonalak
    const paths = {
      win32: [
        'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
      ],
      darwin: [
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
      ],
      linux: [
        '/usr/bin/brave-browser',
        '/usr/bin/brave',
        '/snap/bin/brave'
      ]
    };

    const platformPaths = paths[process.platform] || paths.linux;
    
    for (const p of platformPaths) {
      try {
        const fs = require('fs');
        if (fs.existsSync(p)) {
          return p;
        }
      } catch (e) {}
    }
    
    throw new Error('Brave böngésző nem található. Állítsd be a BRAVE_PATH környezeti változót!');
  }

  async scrape(url, options = {}) {
    const page = await this.browser.newPage();
    
    try {
      // User agent beállítása
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      
      // Navigálás
      await page.goto(url, { 
        waitUntil: options.waitUntil || 'networkidle2',
        timeout: options.timeout || 30000 
      });

      // Várakozás további tartalomra
      if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, { timeout: 10000 });
      }

      if (options.waitTime) {
        await page.waitForTimeout(options.waitTime);
      }

      // Screenshot készítése ha kell
      let screenshot = null;
      if (options.screenshot) {
        screenshot = await page.screenshot({ 
          fullPage: true, 
          encoding: 'base64' 
        });
      }

      // Tartalom kinyerése
      const html = await page.content();
      const $ = cheerio.load(html);
      
      // Metadata gyűjtése
      const metadata = {
        title: $('title').text() || $('meta[property="og:title"]').attr('content'),
        description: $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content'),
        url: page.url(),
        language: $('html').attr('lang') || 'en',
        author: $('meta[name="author"]').attr('content'),
        publishedTime: $('meta[property="article:published_time"]').attr('content'),
        modifiedTime: $('meta[property="article:modified_time"]').attr('content')
      };

      // Tiszta szöveg és markdown
      const bodyHtml = $('body').html() || html;
      const markdown = this.turndownService.turndown(bodyHtml);
      const text = $('body').text().replace(/\s+/g, ' ').trim();

      // Linkek gyűjtése
      const links = [];
      $('a[href]').each((_, elem) => {
        const href = $(elem).attr('href');
        const text = $(elem).text().trim();
        if (href && !href.startsWith('#')) {
          links.push({
            href: new URL(href, url).href,
            text: text || 'No text'
          });
        }
      });

      return {
        url: page.url(),
        title: metadata.title,
        metadata,
        markdown,
        text,
        html: options.includeHtml ? html : undefined,
        links: options.includeLinks ? links : undefined,
        screenshot: screenshot ? `data:image/png;base64,${screenshot}` : undefined
      };

    } finally {
      await page.close();
    }
  }

  async crawl(startUrl, options = {}) {
    const { 
      maxPages = 10, 
      sameDomain = true,
      includePattern,
      excludePattern 
    } = options;

    const visited = new Set();
    const toVisit = [startUrl];
    const results = [];
    const startDomain = new URL(startUrl).hostname;

    while (toVisit.length > 0 && results.length < maxPages) {
      const url = toVisit.shift();
      
      if (visited.has(url)) continue;
      visited.add(url);

      // URL szűrés
      if (includePattern && !new RegExp(includePattern).test(url)) continue;
      if (excludePattern && new RegExp(excludePattern).test(url)) continue;
      
      try {
        console.error(`Crawling: ${url}`);
        const result = await this.scrape(url, { includeLinks: true });
        results.push(result);

        // Új linkek hozzáadása
        if (result.links) {
          for (const link of result.links) {
            const linkUrl = new URL(link.href);
            
            if (sameDomain && linkUrl.hostname !== startDomain) continue;
            if (!visited.has(link.href) && !toVisit.includes(link.href)) {
              toVisit.push(link.href);
            }
          }
        }
      } catch (error) {
        console.error(`Hiba ${url} crawl során: ${error.message}`);
      }
    }

    return {
      startUrl,
      crawledPages: results.length,
      results
    };
  }

  async search(query, options = {}) {
    const searchUrl = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
    const page = await this.browser.newPage();
    
    try {
      await page.goto(searchUrl, { 
        waitUntil: 'domcontentloaded',
        timeout: 15000 
      });
      
      // Várakozás az eredményekre - több selector próbálása
      try {
        await page.waitForSelector('.snippet', { timeout: 5000 });
      } catch (e) {
        // Alternatív selectorok próbálása
        await page.waitForSelector('[data-testid="result"]', { timeout: 5000 });
      }

      const results = await page.evaluate(() => {
        const items = [];
        document.querySelectorAll('.snippet').forEach(snippet => {
          const titleEl = snippet.querySelector('.snippet-title');
          const descEl = snippet.querySelector('.snippet-description');
          const urlEl = snippet.querySelector('.snippet-url');
          
          if (titleEl && urlEl) {
            items.push({
              title: titleEl.innerText,
              url: urlEl.innerText,
              description: descEl ? descEl.innerText : ''
            });
          }
        });
        return items;
      });

      return {
        query,
        results: results.slice(0, options.limit || 10)
      };

    } finally {
      await page.close();
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }

  async login(params) {
    const page = await this.browser.newPage();
    
    try {
      // Human-like behavior
      await page.setViewport({
        width: 1366 + Math.floor(Math.random() * 100),
        height: 768 + Math.floor(Math.random() * 100)
      });
      
      // Random mouse movements
      await page.mouse.move(
        Math.random() * 1000,
        Math.random() * 700
      );
      
      // Site-specific login flows
      const loginConfigs = {
        gmail: {
          url: 'https://accounts.google.com',
          usernameSelector: 'input[type="email"]',
          passwordSelector: 'input[type="password"]',
          nextButtonSelector: '#identifierNext',
          submitSelector: '#passwordNext',
          waitForLogin: 'a[aria-label*="Google Account"]',
          steps: 'sequential' // username first, then password
        },
        facebook: {
          url: 'https://www.facebook.com',
          usernameSelector: 'input[name="email"]',
          passwordSelector: 'input[name="pass"]',
          submitSelector: 'button[name="login"]',
          waitForLogin: 'div[role="navigation"]',
          steps: 'simultaneous'
        },
        twitter: {
          url: 'https://twitter.com/login',
          usernameSelector: 'input[autocomplete="username"]',
          passwordSelector: 'input[type="password"]',
          nextButtonSelector: 'div[role="button"]:has-text("Next")',
          submitSelector: 'div[role="button"]:has-text("Log in")',
          waitForLogin: 'a[aria-label="Profile"]',
          steps: 'sequential'
        },
        linkedin: {
          url: 'https://www.linkedin.com/login',
          usernameSelector: 'input[id="username"]',
          passwordSelector: 'input[id="password"]',
          submitSelector: 'button[type="submit"]',
          waitForLogin: 'nav[role="navigation"]',
          steps: 'simultaneous'
        },
        instagram: {
          url: 'https://www.instagram.com/accounts/login/',
          usernameSelector: 'input[name="username"]',
          passwordSelector: 'input[type="password"]',
          submitSelector: 'button[type="submit"]',
          waitForLogin: 'svg[aria-label="Home"]',
          steps: 'simultaneous'
        }
      };

      const config = params.site === 'custom' 
        ? await this.detectLoginConfig(params.customUrl)
        : loginConfigs[params.site];

      if (!config) {
        throw new Error('Unsupported site or unable to detect login form');
      }

      // Navigate to login page
      await page.goto(params.site === 'custom' ? params.customUrl : config.url, {
        waitUntil: 'networkidle2'
      });

      // Human-like delay
      await this.humanDelay();

      // Execute login based on flow type
      if (config.steps === 'sequential') {
        // Gmail/Twitter style - username first
        await page.waitForSelector(config.usernameSelector, { visible: true });
        await page.click(config.usernameSelector);
        await this.humanType(page, config.usernameSelector, params.credentials.username);
        
        if (config.nextButtonSelector) {
          await page.click(config.nextButtonSelector);
          await page.waitForNavigation({ waitUntil: 'networkidle2' });
        }
        
        await page.waitForSelector(config.passwordSelector, { visible: true });
        await page.click(config.passwordSelector);
        await this.humanType(page, config.passwordSelector, params.credentials.password);
        await page.click(config.submitSelector);
        
      } else {
        // Facebook/LinkedIn style - both fields together
        await page.waitForSelector(config.usernameSelector, { visible: true });
        await page.click(config.usernameSelector);
        await this.humanType(page, config.usernameSelector, params.credentials.username);
        
        await page.click(config.passwordSelector);
        await this.humanType(page, config.passwordSelector, params.credentials.password);
        
        await this.humanDelay();
        await page.click(config.submitSelector);
      }

      // Wait for login to complete
      try {
        await page.waitForSelector(config.waitForLogin, { 
          visible: true, 
          timeout: 30000 
        });
      } catch (e) {
        // Check for 2FA
        const needs2FA = await this.check2FA(page);
        if (needs2FA && params.credentials.totp) {
          await this.handle2FA(page, params.credentials.totp);
          await page.waitForSelector(config.waitForLogin, { 
            visible: true, 
            timeout: 30000 
          });
        } else if (needs2FA) {
          throw new Error('2FA required but no TOTP code provided');
        } else {
          throw new Error('Login failed - could not verify successful login');
        }
      }

      // Save session if requested
      if (params.saveSession) {
        const cookies = await page.cookies();
        const sessionData = {
          site: params.site,
          cookies,
          userAgent: await page.evaluate(() => navigator.userAgent),
          timestamp: Date.now()
        };
        
        // Store in local file system
        const sessionPath = path.join(process.cwd(), '.sessions', `${params.site}_session.json`);
        await fs.mkdir(path.dirname(sessionPath), { recursive: true });
        await fs.writeFile(sessionPath, JSON.stringify(sessionData, null, 2));
      }

      // Get some proof of login
      const proof = await page.evaluate(() => {
        return {
          url: window.location.href,
          title: document.title,
          userName: document.querySelector('[data-testid="ProfileHeader_Name"]')?.textContent ||
                    document.querySelector('.userName')?.textContent ||
                    document.querySelector('[aria-label*="Account"]')?.textContent ||
                    'Logged in'
        };
      });

      return {
        success: true,
        site: params.site,
        proof,
        message: 'Successfully logged in',
        sessionSaved: params.saveSession
      };

    } catch (error) {
      // Take screenshot for debugging
      const screenshot = await page.screenshot({ encoding: 'base64' });
      
      return {
        success: false,
        error: error.message,
        screenshot: `data:image/png;base64,${screenshot}`,
        hint: 'Check the screenshot to see what went wrong'
      };
    } finally {
      await page.close();
    }
  }

  async detectLoginConfig(url) {
    // Intelligent login form detection for custom sites
    const page = await this.browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle2' });
      
      const config = await page.evaluate(() => {
        // Find username field
        const usernameSelectors = [
          'input[type="email"]',
          'input[name="username"]',
          'input[name="email"]',
          'input[id="username"]',
          'input[placeholder*="email" i]',
          'input[placeholder*="username" i]'
        ];
        
        let usernameSelector = null;
        for (const selector of usernameSelectors) {
          if (document.querySelector(selector)) {
            usernameSelector = selector;
            break;
          }
        }

        // Find password field
        const passwordSelector = 'input[type="password"]';
        
        // Find submit button
        const submitSelectors = [
          'button[type="submit"]',
          'input[type="submit"]',
          'button:contains("Log in")',
          'button:contains("Sign in")',
          'button:contains("Login")'
        ];
        
        let submitSelector = null;
        for (const selector of submitSelectors) {
          try {
            if (document.querySelector(selector)) {
              submitSelector = selector;
              break;
            }
          } catch (e) {}
        }

        return {
          url: window.location.href,
          usernameSelector,
          passwordSelector,
          submitSelector,
          steps: 'simultaneous'
        };
      });
      
      await page.close();
      return config;
      
    } catch (error) {
      await page.close();
      return null;
    }
  }

  async humanDelay(min = 500, max = 2000) {
    const delay = min + Math.random() * (max - min);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  async humanType(page, selector, text) {
    await page.focus(selector);
    for (const char of text) {
      await page.keyboard.type(char, { 
        delay: 50 + Math.random() * 100 
      });
      // Occasional pause
      if (Math.random() < 0.1) {
        await this.humanDelay(100, 300);
      }
    }
  }

  async check2FA(page) {
    const selectors = [
      'input[name="totp"]',
      'input[name="code"]',
      'input[placeholder*="code" i]',
      'input[placeholder*="2fa" i]',
      'input[aria-label*="code" i]'
    ];
    
    for (const selector of selectors) {
      if (await page.$(selector)) {
        return true;
      }
    }
    return false;
  }

  async handle2FA(page, code) {
    const selectors = [
      'input[name="totp"]',
      'input[name="code"]',
      'input[placeholder*="code" i]'
    ];
    
    for (const selector of selectors) {
      if (await page.$(selector)) {
        await page.click(selector);
        await this.humanType(page, selector, code);
        
        // Find and click submit
        const submitBtn = await page.$('button[type="submit"], button:contains("Verify")');
        if (submitBtn) {
          await submitBtn.click();
        }
        break;
      }
    }
  }

  async executeSessionAction(params) {
    // Load saved session
    const sessionPath = path.join(process.cwd(), '.sessions', `${params.site}_session.json`);
    
    try {
      const sessionData = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));
      
      if (Date.now() - sessionData.timestamp > 24 * 60 * 60 * 1000) {
        throw new Error('Session expired, please login again');
      }

      const page = await this.browser.newPage();
      
      // Restore session
      await page.setUserAgent(sessionData.userAgent);
      await page.setCookie(...sessionData.cookies);
      
      // Navigate to appropriate page based on action
      const actionConfigs = {
        gmail: {
          read_emails: async () => {
            await page.goto('https://mail.google.com', { waitUntil: 'networkidle2' });
            await page.waitForSelector('tr.zA', { timeout: 30000 });
            
            const emails = await page.evaluate(() => {
              const emailRows = document.querySelectorAll('tr.zA');
              return Array.from(emailRows).slice(0, 10).map(row => ({
                from: row.querySelector('.yW')?.textContent,
                subject: row.querySelector('.y6')?.textContent,
                snippet: row.querySelector('.y2')?.textContent,
                time: row.querySelector('.xW')?.textContent
              }));
            });
            
            return { emails };
          },
          send_email: async () => {
            await page.goto('https://mail.google.com', { waitUntil: 'networkidle2' });
            await page.click('.T-I.T-I-KE'); // Compose button
            
            await this.humanDelay();
            await page.type('input[name="to"]', params.parameters.to);
            await page.type('input[name="subjectbox"]', params.parameters.subject);
            await page.type('div[role="textbox"]', params.parameters.body);
            
            await page.keyboard.down('Control');
            await page.keyboard.press('Enter');
            await page.keyboard.up('Control');
            
            return { success: true, message: 'Email sent' };
          }
        },
        facebook: {
          get_messages: async () => {
            await page.goto('https://www.facebook.com/messages', { waitUntil: 'networkidle2' });
            // Facebook Messenger scraping logic
            return { messages: [] };
          },
          post_content: async () => {
            await page.goto('https://www.facebook.com', { waitUntil: 'networkidle2' });
            await page.click('[role="button"][aria-label*="What\'s on your mind"]');
            await this.humanDelay();
            await page.type('[role="textbox"]', params.parameters.content);
            await page.click('[aria-label="Post"]');
            return { success: true, message: 'Posted to Facebook' };
          }
        }
      };

      // Execute action
      let result;
      if (params.action === 'custom' && params.customScript) {
        result = await page.evaluate(params.customScript);
      } else if (actionConfigs[params.site] && actionConfigs[params.site][params.action]) {
        result = await actionConfigs[params.site][params.action]();
      } else {
        throw new Error(`Action ${params.action} not implemented for ${params.site}`);
      }

      await page.close();
      return { success: true, data: result };

    } catch (error) {
      return { 
        success: false, 
        error: error.message,
        hint: 'You may need to login again'
      };
    }
  }

  async listSessions() {
    const sessionsDir = path.join(process.cwd(), '.sessions');
    
    try {
      const files = await fs.readdir(sessionsDir);
      const sessions = [];
      
      for (const file of files) {
        if (file.endsWith('_session.json')) {
          const sessionPath = path.join(sessionsDir, file);
          const sessionData = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));
          
          sessions.push({
            site: sessionData.site,
            age: Date.now() - sessionData.timestamp,
            ageHuman: this.humanizeTime(Date.now() - sessionData.timestamp),
            expired: Date.now() - sessionData.timestamp > 24 * 60 * 60 * 1000,
            cookieCount: sessionData.cookies.length
          });
        }
      }
      
      return {
        sessions,
        total: sessions.length,
        active: sessions.filter(s => !s.expired).length,
        expired: sessions.filter(s => s.expired).length
      };
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { sessions: [], total: 0, active: 0, expired: 0 };
      }
      throw error;
    }
  }

  // Visual CAPTCHA handling
  async visualCaptcha(params) {
    const page = await this.getCurrentPage();
    
    if (params.action === 'capture') {
      // Teljes képernyőkép a CAPTCHA területről
      const screenshot = await page.screenshot({ 
        fullPage: false,
        encoding: 'base64' 
      });
      
      // Elemek pozíciójának meghatározása
      const elements = await page.evaluate(() => {
        const captcha = document.querySelector('.g-recaptcha, #captcha, [data-captcha], iframe[src*="recaptcha"], iframe[src*="captcha"]');
        const rect = captcha?.getBoundingClientRect();
        
        // Minden kattintható elem megkeresése
        const clickables = Array.from(document.querySelectorAll('img, button, div[role="button"], canvas, .captcha-image, [class*="captcha"]'))
          .filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .map(el => {
            const r = el.getBoundingClientRect();
            return {
              tag: el.tagName,
              classes: el.className,
              text: el.textContent?.trim() || el.alt || el.title || '',
              bounds: { 
                x: Math.round(r.x), 
                y: Math.round(r.y), 
                width: Math.round(r.width), 
                height: Math.round(r.height),
                centerX: Math.round(r.x + r.width/2),
                centerY: Math.round(r.y + r.height/2)
              }
            };
          });
        
        return {
          captchaArea: rect ? { 
            x: Math.round(rect.x), 
            y: Math.round(rect.y), 
            width: Math.round(rect.width), 
            height: Math.round(rect.height) 
          } : null,
          clickableElements: clickables,
          viewport: { 
            width: window.innerWidth, 
            height: window.innerHeight 
          },
          pageTitle: document.title
        };
      });
      
      return {
        screenshot: `data:image/png;base64,${screenshot}`,
        elements,
        hint: "Screenshot készült. Az elemek koordinátái megtalálhatók az 'elements' objektumban. Használd a brave_mouse_control tool-t a kattintáshoz!"
      };
    }
    
    if (params.action === 'click' && params.coordinates) {
      await this.humanMouseMove(page, params.coordinates.x, params.coordinates.y);
      await page.mouse.click(params.coordinates.x, params.coordinates.y);
      await this.humanDelay(500, 1000);
      
      // Screenshot a kattintás után
      const afterClick = await page.screenshot({ encoding: 'base64' });
      
      return { 
        success: true, 
        clicked: params.coordinates,
        screenshotAfter: `data:image/png;base64,${afterClick}`,
        message: `Kattintottam: x=${params.coordinates.x}, y=${params.coordinates.y}`
      };
    }
    
    if (params.action === 'type' && params.text) {
      // Először kattintsunk a beviteli mezőre ha van koordináta
      if (params.coordinates) {
        await page.mouse.click(params.coordinates.x, params.coordinates.y);
        await this.humanDelay(100, 300);
      }
      
      // Emberi gépelés szimuláció
      await this.humanType(page, null, params.text);
      
      return { 
        success: true, 
        typed: params.text,
        message: `Beírtam: "${params.text}"`
      };
    }
  }

  // Mouse control
  async mouseControl(params) {
    const page = await this.getCurrentPage();
    
    // Track mouse position
    await page.evaluateOnNewDocument(() => {
      window.mouseX = 0;
      window.mouseY = 0;
      document.addEventListener('mousemove', (e) => {
        window.mouseX = e.clientX;
        window.mouseY = e.clientY;
      });
    });
    
    switch (params.action) {
      case 'move':
        await this.humanMouseMove(page, params.x, params.y);
        return { success: true, action: 'move', position: { x: params.x, y: params.y } };
        
      case 'click':
        await this.humanMouseMove(page, params.x, params.y);
        await this.humanDelay(100, 300);
        await page.mouse.click(params.x, params.y);
        return { success: true, action: 'click', position: { x: params.x, y: params.y } };
        
      case 'doubleClick':
        await this.humanMouseMove(page, params.x, params.y);
        await page.mouse.click(params.x, params.y, { clickCount: 2 });
        return { success: true, action: 'doubleClick', position: { x: params.x, y: params.y } };
        
      case 'rightClick':
        await this.humanMouseMove(page, params.x, params.y);
        await page.mouse.click(params.x, params.y, { button: 'right' });
        return { success: true, action: 'rightClick', position: { x: params.x, y: params.y } };
        
      case 'drag':
        await this.humanMouseMove(page, params.x, params.y);
        await page.mouse.down();
        await this.humanMouseMove(page, params.targetX, params.targetY, params.duration || 1000);
        await page.mouse.up();
        return { 
          success: true, 
          action: 'drag', 
          from: { x: params.x, y: params.y },
          to: { x: params.targetX, y: params.targetY }
        };
        
      case 'hover':
        await this.humanMouseMove(page, params.x, params.y);
        await this.humanDelay(params.duration || 1000, params.duration || 1500);
        return { success: true, action: 'hover', position: { x: params.x, y: params.y } };
        
      case 'screenshot_with_cursor':
        // Rajzoljunk egy virtuális kurzort
        await page.evaluate((x, y) => {
          const cursor = document.createElement('div');
          cursor.style.position = 'fixed';
          cursor.style.left = x + 'px';
          cursor.style.top = y + 'px';
          cursor.style.width = '20px';
          cursor.style.height = '20px';
          cursor.style.backgroundColor = 'red';
          cursor.style.borderRadius = '50%';
          cursor.style.zIndex = '999999';
          cursor.style.pointerEvents = 'none';
          cursor.id = 'virtual-cursor';
          document.body.appendChild(cursor);
        }, params.x || 0, params.y || 0);
        
        const screenshot = await page.screenshot({ encoding: 'base64' });
        
        // Töröljük a virtuális kurzort
        await page.evaluate(() => {
          document.getElementById('virtual-cursor')?.remove();
        });
        
        return {
          screenshot: `data:image/png;base64,${screenshot}`,
          cursorPosition: { x: params.x || 0, y: params.y || 0 },
          hint: "Piros pont jelzi a kurzor pozíciót"
        };
        
      default:
        return { success: false, error: 'Ismeretlen művelet' };
    }
  }

  // Visual element inspection
  async visualInspect(params) {
    const page = await this.getCurrentPage();
    
    if (params.mode === 'full_analysis') {
      // Teljes oldal elemzés
      const analysis = await page.evaluate(() => {
        const elements = [];
        
        // Minden interaktív elem
        const selectors = [
          'button', 'a', 'input', 'select', 'textarea', 
          '[onclick]', '[role="button"]', '[role="link"]',
          '.btn', '.button', '[class*="button"]'
        ];
        
        const processedElements = new Set();
        
        selectors.forEach(selector => {
          document.querySelectorAll(selector).forEach(el => {
            if (processedElements.has(el)) return;
            processedElements.add(el);
            
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const isVisible = rect.width > 0 && rect.height > 0 && 
                            style.display !== 'none' && 
                            style.visibility !== 'hidden' &&
                            style.opacity !== '0';
            
            if (isVisible) {
              elements.push({
                type: el.tagName.toLowerCase(),
                text: el.textContent?.trim() || el.value || el.placeholder || el.alt || '',
                ariaLabel: el.getAttribute('aria-label'),
                position: { 
                  x: Math.round(rect.x + rect.width/2), 
                  y: Math.round(rect.y + rect.height/2) 
                },
                bounds: {
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height)
                },
                style: {
                  backgroundColor: style.backgroundColor,
                  color: style.color,
                  fontSize: style.fontSize
                },
                clickable: true,
                href: el.href || null
              });
            }
          });
        });
        
        // Rendezés pozíció szerint (fentről le, balról jobbra)
        elements.sort((a, b) => {
          if (Math.abs(a.bounds.y - b.bounds.y) < 10) {
            return a.bounds.x - b.bounds.x;
          }
          return a.bounds.y - b.bounds.y;
        });
        
        return {
          elements,
          pageInfo: {
            title: document.title,
            url: window.location.href,
            scrollHeight: document.documentElement.scrollHeight,
            clientHeight: document.documentElement.clientHeight
          }
        };
      });
      
      const screenshot = await page.screenshot({ encoding: 'base64' });
      
      return {
        screenshot: `data:image/png;base64,${screenshot}`,
        interactiveElements: analysis.elements,
        pageInfo: analysis.pageInfo,
        totalElements: analysis.elements.length,
        hint: `Találtam ${analysis.elements.length} interaktív elemet. Használd a koordinátákat a brave_mouse_control tool-lal!`
      };
    }
    
    if (params.mode === 'find_element' && params.query) {
      // Elem keresése szöveg alapján
      const found = await page.evaluate((query) => {
        const normalizedQuery = query.toLowerCase().trim();
        const elements = Array.from(document.querySelectorAll('*'));
        const matches = [];
        
        elements.forEach(el => {
          const text = (el.textContent?.trim() || '').toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const value = (el.value || '').toLowerCase();
          const placeholder = (el.placeholder || '').toLowerCase();
          const title = (el.title || '').toLowerCase();
          
          const isMatch = text.includes(normalizedQuery) || 
                         aria.includes(normalizedQuery) ||
                         value.includes(normalizedQuery) ||
                         placeholder.includes(normalizedQuery) ||
                         title.includes(normalizedQuery);
          
          if (isMatch && el.offsetWidth > 0 && el.offsetHeight > 0) {
            const rect = el.getBoundingClientRect();
            matches.push({
              text: el.textContent?.trim() || value || placeholder,
              type: el.tagName.toLowerCase(),
              center: { 
                x: Math.round(rect.x + rect.width/2), 
                y: Math.round(rect.y + rect.height/2) 
              },
              bounds: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              },
              matchedIn: text.includes(normalizedQuery) ? 'text' : 
                        aria.includes(normalizedQuery) ? 'aria-label' :
                        value.includes(normalizedQuery) ? 'value' :
                        placeholder.includes(normalizedQuery) ? 'placeholder' : 'title'
            });
          }
        });
        
        return matches;
      }, params.query);
      
      // Screenshot with highlighted matches
      if (found.length > 0) {
        // Highlight találatok
        await page.evaluate((matches) => {
          matches.forEach((match, index) => {
            const highlight = document.createElement('div');
            highlight.style.position = 'fixed';
            highlight.style.left = match.bounds.x + 'px';
            highlight.style.top = match.bounds.y + 'px';
            highlight.style.width = match.bounds.width + 'px';
            highlight.style.height = match.bounds.height + 'px';
            highlight.style.border = '3px solid red';
            highlight.style.backgroundColor = 'rgba(255,0,0,0.1)';
            highlight.style.zIndex = '999998';
            highlight.style.pointerEvents = 'none';
            highlight.className = 'search-highlight';
            
            const label = document.createElement('div');
            label.style.position = 'absolute';
            label.style.top = '-25px';
            label.style.left = '0';
            label.style.backgroundColor = 'red';
            label.style.color = 'white';
            label.style.padding = '2px 5px';
            label.style.fontSize = '12px';
            label.style.fontWeight = 'bold';
            label.textContent = `#${index + 1}`;
            
            highlight.appendChild(label);
            document.body.appendChild(highlight);
          });
        }, found);
        
        const screenshot = await page.screenshot({ encoding: 'base64' });
        
        // Tisztítás
        await page.evaluate(() => {
          document.querySelectorAll('.search-highlight').forEach(el => el.remove());
        });
        
        return {
          found: found.length,
          elements: found,
          screenshot: `data:image/png;base64,${screenshot}`,
          suggestion: `Találtam ${found.length} elemet "${params.query}" keresésre. ` +
                     `Az első elem (#1) koordinátái: x=${found[0].center.x}, y=${found[0].center.y}`
        };
      }
      
      return {
        found: 0,
        elements: [],
        message: `Nem találtam "${params.query}" szöveget tartalmazó elemet az oldalon.`
      };
    }
    
    if (params.mode === 'interactive_map') {
      // Interaktív térkép készítése
      const screenshot = await page.screenshot({ encoding: 'base64' });
      
      // Számozzuk meg az összes kattintható elemet
      const numbered = await page.evaluate(() => {
        const elements = [];
        let counter = 1;
        
        document.querySelectorAll('button, a, input, select, [onclick], [role="button"]').forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            // Szám hozzáadása
            const marker = document.createElement('div');
            marker.style.position = 'fixed';
            marker.style.left = (rect.x + rect.width/2 - 12) + 'px';
            marker.style.top = (rect.y + rect.height/2 - 12) + 'px';
            marker.style.width = '24px';
            marker.style.height = '24px';
            marker.style.backgroundColor = '#ff0000';
            marker.style.color = 'white';
            marker.style.borderRadius = '50%';
            marker.style.display = 'flex';
            marker.style.alignItems = 'center';
            marker.style.justifyContent = 'center';
            marker.style.fontSize = '12px';
            marker.style.fontWeight = 'bold';
            marker.style.zIndex = '999999';
            marker.style.pointerEvents = 'none';
            marker.className = 'element-marker';
            marker.textContent = counter;
            document.body.appendChild(marker);
            
            elements.push({
              number: counter,
              text: el.textContent?.trim() || el.value || '',
              type: el.tagName.toLowerCase(),
              center: {
                x: Math.round(rect.x + rect.width/2),
                y: Math.round(rect.y + rect.height/2)
              }
            });
            
            counter++;
          }
        });
        
        return elements;
      });
      
      const numberedScreenshot = await page.screenshot({ encoding: 'base64' });
      
      // Tisztítás
      await page.evaluate(() => {
        document.querySelectorAll('.element-marker').forEach(el => el.remove());
      });
      
      return {
        screenshot: `data:image/png;base64,${numberedScreenshot}`,
        elements: numbered,
        totalElements: numbered.length,
        hint: "Minden kattintható elem meg van számozva. Használd a számot vagy a koordinátákat a kattintáshoz!"
      };
    }
  }

  // Emberi egérmozgás szimuláció Bézier görbével
  async humanMouseMove(page, targetX, targetY, duration = 500) {
    const steps = Math.ceil(duration / 20);
    
    // Jelenlegi pozíció lekérése
    const currentPos = await page.evaluate(() => ({ 
      x: window.mouseX || 0, 
      y: window.mouseY || 0 
    })).catch(() => ({ x: 0, y: 0 }));
    
    // Kontroll pontok a Bézier görbéhez (természetes ív)
    const cp1x = currentPos.x + (targetX - currentPos.x) * 0.25 + (Math.random() - 0.5) * 50;
    const cp1y = currentPos.y + (targetY - currentPos.y) * 0.25 + (Math.random() - 0.5) * 50;
    const cp2x = currentPos.x + (targetX - currentPos.x) * 0.75 + (Math.random() - 0.5) * 50;
    const cp2y = currentPos.y + (targetY - currentPos.y) * 0.75 + (Math.random() - 0.5) * 50;
    
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      
      // Cubic Bézier görbe számítás
      const x = Math.pow(1-t, 3) * currentPos.x +
                3 * Math.pow(1-t, 2) * t * cp1x +
                3 * (1-t) * Math.pow(t, 2) * cp2x +
                Math.pow(t, 3) * targetX;
                
      const y = Math.pow(1-t, 3) * currentPos.y +
                3 * Math.pow(1-t, 2) * t * cp1y +
                3 * (1-t) * Math.pow(t, 2) * cp2y +
                Math.pow(t, 3) * targetY;
      
      // Kis random tremor emberi hatásért
      const tremor = i < steps ? 1 : 0; // Csak mozgás közben
      const finalX = x + (Math.random() - 0.5) * tremor;
      const finalY = y + (Math.random() - 0.5) * tremor;
      
      await page.mouse.move(finalX, finalY);
      
      // Update tracked position
      await page.evaluate((x, y) => {
        window.mouseX = x;
        window.mouseY = y;
      }, finalX, finalY).catch(() => {});
      
      await new Promise(r => setTimeout(r, 20));
    }
  }

  humanizeTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days} nap`;
    if (hours > 0) return `${hours} óra`;
    if (minutes > 0) return `${minutes} perc`;
    return `${seconds} másodperc`;
  }

  async getCurrentPage() {
    const pages = await this.browser.pages();
    return pages[pages.length - 1]; // Utolsó aktív oldal
  }

  async clearSessions(site) {
    const sessionsDir = path.join(process.cwd(), '.sessions');
    
    try {
      if (site === 'all') {
        // Töröljük az összes session-t
        const files = await fs.readdir(sessionsDir);
        for (const file of files) {
          if (file.endsWith('_session.json')) {
            await fs.unlink(path.join(sessionsDir, file));
          }
        }
        return { success: true, message: 'Minden session törölve' };
      } else {
        // Csak egy specifikus site session-jét töröljük
        const sessionPath = path.join(sessionsDir, `${site}_session.json`);
        await fs.unlink(sessionPath);
        return { success: true, message: `${site} session törölve` };
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { success: false, message: 'Nem található ilyen session' };
      }
      throw error;
    }
  }
}