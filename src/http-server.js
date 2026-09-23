import express from 'express';
import cors from 'cors';
import https from 'https';
import { WebSocketServer } from 'ws';
import { BraveController } from './brave-controller.js';
import { tools } from './tools.js';
import dotenv from 'dotenv';
import { createRequire } from 'module';
import crypto from 'crypto';
import { hostOnly, redactUrls } from './egress.js';
import { toolTimeoutMs } from './tool-timeout.js';

const require = createRequire(import.meta.url);

dotenv.config();

// Brave controller példány
let braveController = null;

const app = express();
const PORT = process.env.PORT || process.env.HTTP_PORT || 3000;

// === Stability knobs (2026-05-14 stability plan) ===
// Hard ceiling for tools/call wall-clock. Anything that takes longer is
// almost certainly a leaked Puppeteer page or stuck FlareSolverr call;
// we return a JSONRPC error instead of letting the client hang 30+s.
const TOOL_CALL_TIMEOUT_MS = parseInt(
  process.env.TOOL_CALL_TIMEOUT_MS || '25000', 10
);
// Deep healthcheck: probes brave_search end-to-end so Railway can spot
// the "/health works but tools/call hangs" failure mode.
const HEALTH_DEEP_TIMEOUT_MS = parseInt(
  process.env.HEALTH_DEEP_TIMEOUT_MS || '8000', 10
);
const HEALTH_DEEP_CACHE_MS = parseInt(
  process.env.HEALTH_DEEP_CACHE_MS || '30000', 10
);
let _deepCache = { ts: 0, ok: true, reason: '' };

// === 2026-07-08: zombi-fix — valódi életjel + tervezett újjászületés ===
// A /health mostantól browser-próbát jelent (503 halott böngészőnél); a friss
// watchdog-próbát használja, csak elavultság esetén fut inline próba.
const HEALTH_PROBE_MAX_AGE_MS = parseInt(
  process.env.HEALTH_PROBE_MAX_AGE_MS || '90000', 10
);
// MEGELŐZŐ ÚJJÁSZÜLETÉS: 6 óránként graceful exit(0) forgalommentes
// pillanatban (in-flight hívások megvárva; +1 óra után mindenképp).
// Indok: a 07-05-ös stabilizálás után is ~8-14 óránként zombult a szolgáltatás
// (éjszaka, forgalom nélkül is) → memória/állapot-degradáció; a node-processz
// RSS-ét csak a teljes újraindulás nullázza. Railway-n a restartPolicy húzza
// vissza (railway.json: ALWAYS — az ON_FAILURE a tervezett exit(0)-t NEM
// indítaná újra!).
const REBIRTH_AFTER_MS = parseInt(
  process.env.BRAVE_REBIRTH_AFTER_MS || String(6 * 60 * 60 * 1000), 10
);
const REBIRTH_HARD_EXTRA_MS = parseInt(
  process.env.BRAVE_REBIRTH_HARD_EXTRA_MS || String(60 * 60 * 1000), 10
);
const _bornAt = Date.now();
// In-flight tool-hívás számláló — a rebirth csak üresjáratban lő.
let _inFlight = 0;
async function trackInFlight(fn) {
  _inFlight++;
  try { return await fn(); } finally { _inFlight--; }
}

// ── NAPLÓ-REDAKCIÓ — 2026-09-22 ─────────────────────────────────────────
// Korábban a /mcp a TELJES kérés-törzset és MINDEN fejlécet naplózta (benne
// Authorization/Cookie, beírt szöveg, jelszó a brave_login-ban, scriptek,
// query-stringes URL-ek). Mostantól egy sor kérésenként: metódus, tool-név,
// az URL HOSTJA, kérés-azonosító, státusz, időtartam. Semmi más.
const _safeTok = (v, n = 60) => String(v ?? '').replace(/[^\w./:-]/g, '').slice(0, n) || '-';
function _argsHost(args) {
  if (!args || typeof args !== 'object') return '-';
  for (const k of ['url', 'startUrl', 'customUrl']) {
    if (typeof args[k] === 'string' && args[k]) return hostOnly(args[k]);
  }
  return '-';
}
function mcpAccessLog(req, res, kind) {
  const t0 = Date.now();
  const rid = crypto.randomBytes(4).toString('hex');
  res.on('finish', () => {
    const b = (req.body && typeof req.body === 'object') ? req.body : {};
    let method = '-', tool = '-', host = '-';
    if (kind === 'mcp') {
      method = _safeTok(b.method);
      if (b.method === 'tools/call') {
        tool = _safeTok(b.params?.name);
        host = _argsHost(b.params?.arguments);
      }
    } else {
      method = 'tools/call';
      tool = _safeTok(req.params?.toolName);
      host = _argsHost(b);
    }
    const client = _safeTok(req.get('x-client-id'), 40);
    console.log(
      `[${kind}] rid=${rid} id=${_safeTok(b.id, 40)} method=${method} tool=${tool} ` +
      `host=${host} client=${client} status=${res.statusCode} ms=${Date.now() - t0}`
    );
  });
  return rid;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// CORS és JSON middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));
app.use(express.json({ limit: '50mb' }));

// Simple auth middleware (optional)
const simpleAuth = (req, res, next) => {
  // Skip auth for health check and static files
  if (req.path === '/health' || req.path.startsWith('/static')) {
    return next();
  }
  
  // Accept any Authorization header or no auth
  next();
};

// OAuth token endpoints - both /token and /oauth/token
const tokenHandler = (req, res) => {
  // 2026-09-22: a törzs (code, client_secret, refresh_token) NEM kerül naplóba.
  console.log(`🔐 OAuth token request: grant_type=${_safeTok(req.body?.grant_type, 40)}`);
  
  // Accept any token request
  res.json({
    access_token: 'brave-mcp-access-token',
    token_type: 'Bearer',
    expires_in: 86400,
    scope: 'read write'
  });
};

app.post('/token', tokenHandler);
app.post('/oauth/token', tokenHandler);

// Both /authorize and /oauth/authorize for compatibility
const authorizeHandler = (req, res) => {
  console.log(`🔐 OAuth authorize request: client_id=${_safeTok(req.query?.client_id, 60)} redirect_host=${hostOnly(req.query?.redirect_uri)}`);
  
  const { client_id, redirect_uri, response_type, state } = req.query;
  
  if (response_type === 'code') {
    const code = 'brave-auth-code-' + Math.random().toString(36).substr(2, 9);
    const redirectUrl = `${redirect_uri}?code=${code}${state ? `&state=${state}` : ''}`;
    console.log(`🔐 Redirecting to host=${hostOnly(redirect_uri)}`);
    return res.redirect(redirectUrl);
  }
  
  res.status(400).json({ 
    error: 'unsupported_response_type',
    supported: ['code']
  });
};

app.get('/authorize', authorizeHandler);
app.get('/oauth/authorize', authorizeHandler);

// OpenID Connect discovery endpoint (Claude might need this)
app.get('/.well-known/openid_configuration', (req, res) => {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  
  res.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic', 'none']
  });
});

// Health check endpoint — 2026-07-08: VALÓDI ÉLETJEL. A puszta HTTP-életjel
// NEM egészség: a 07-05 utáni éles zombiknál a /health 200-at adott, miközben
// a böngésző halott/hung volt. Mostantól a /health browser-próbát jelent:
// a watchdog friss (<90s) próbáját használja, elavultság esetén inline próba
// fut (5s korlát). Halott/hung böngésző → 503. A próba hálózat-független
// (about:blank), így külső net-akadozás NEM okoz fals restartot; a lazy-init
// restart-hurok sem áll fenn, mert a próba szükség esetén maga indít böngészőt
// — ha az launch-képes, a válasz 200.
app.get('/health', async (req, res) => {
  const body = {
    server: 'brave-mcp-server',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    auth: 'optional',
    uptime_s: Math.round(process.uptime()),
    node_rss_mb: Math.round(process.memoryUsage().rss / 1048576),
    in_flight_tools: _inFlight,
    rebirth_in_s: Math.max(0, Math.round((_bornAt + REBIRTH_AFTER_MS - Date.now()) / 1000)),
  };
  let alive = false;
  try {
    if (!braveController) {
      braveController = new BraveController();
    }
    let probe = braveController._lastProbe;
    // Inline próba kell, ha (a) nincs friss watchdog-próba, VAGY (b) a handle
    // láthatóan halott, de a cache-elt próba még zöldet mutatna (a disconnect
    // és a következő watchdog-tick közti ablakban ne hazudjunk 200-at —
    // az inline próba ráadásul ensureBrowser()-rel azonnal fel is támaszt).
    const handleAlive = !!(braveController.browser && braveController.browser.isConnected());
    if (!probe.ts || Date.now() - probe.ts > HEALTH_PROBE_MAX_AGE_MS || (!handleAlive && probe.ok)) {
      probe = await braveController.probeBrowser();
    }
    alive = probe.ok === true;
    Object.assign(body, braveController.getHealthStats());
    Object.assign(body, await braveController.getChromiumStats());
  } catch (e) {
    body.stats_error = e.message;
  }
  body.status = alive ? 'ok' : 'dead_browser';
  res.status(alive ? 200 : 503).json(body);
});

// Deep health check — probes brave_search end-to-end and reports 503 if
// the inner tools/call layer is stuck. Result is cached for
// HEALTH_DEEP_CACHE_MS so Railway healthchecks don't hammer Brave-Search.
//
// Use this path in railway.json `healthcheckPath` so Railway auto-
// restarts the container when the deep probe fails — the "/health
// works but tools/call hangs" failure mode (observed 2026-05-14)
// becomes self-healing.
app.get('/health/deep', async (req, res) => {
  const now = Date.now();
  if (now - _deepCache.ts < HEALTH_DEEP_CACHE_MS) {
    return res.status(_deepCache.ok ? 200 : 503).json({
      status: _deepCache.ok ? 'ok' : 'degraded',
      cached: true,
      reason: _deepCache.reason,
      age_ms: now - _deepCache.ts,
      timestamp: new Date().toISOString(),
    });
  }
  try {
    if (!braveController) {
      braveController = new BraveController();
      await braveController.initialize();
    }
    // 2026-07-01: HÁLÓZAT-FÜGGETLEN mély-próba. A régi próba egy ÉLŐ brave_search-öt
    // futtatott (valódi külső scrape) -> ha a net/Cloudflare akadozott, a healthcheck
    // elbukott, Railway feleslegesen újraindított, és a restartPolicyMaxRetries
    // kimerülésével HALVA hagyta a konténert (a crash-loop egyik gyanúsítottja).
    // Az új próba csak azt méri, amit a liveness-nek mérnie kell: ÉL-e a Chromium
    // és VÁLASZOL-e (nem hung) — egy üres lap nyit/evaluate/zár, külső hálózat nélkül.
    await withTimeout(
      (async () => {
        await braveController.ensureBrowser();
        const page = await braveController.newPage();
        try {
          await page.evaluate(() => 1);
        } finally {
          try { await page.close(); } catch (e) { /* irreleváns */ }
        }
      })(),
      HEALTH_DEEP_TIMEOUT_MS,
      'deep-health browser-probe'
    );
    _deepCache = { ts: now, ok: true, reason: '' };
    res.json({
      status: 'ok',
      cached: false,
      probe_timeout_ms: HEALTH_DEEP_TIMEOUT_MS,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    _deepCache = { ts: now, ok: false, reason: err.message };
    console.error('⚠️ Deep healthcheck failed:', err.message);
    res.status(503).json({
      status: 'degraded',
      reason: err.message,
      cached: false,
      timestamp: new Date().toISOString(),
    });
  }
});

// Tools list endpoint
app.get('/tools', (req, res) => {
  const toolList = tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }));
  
  res.json({ tools: toolList });
});

// Tool execution endpoint
app.post('/tools/:toolName', async (req, res) => {
  mcpAccessLog(req, res, 'tools');
  try {
    const toolName = req.params.toolName;
    const params = req.body;
    
    // Find the tool
    const tool = tools.find(t => t.name === toolName);
    if (!tool) {
      return res.status(404).json({ 
        error: `Tool ${toolName} not found`,
        availableTools: tools.map(t => t.name)
      });
    }

    // Initialize browser if needed
    if (!braveController) {
      console.log('🚀 Initializing Brave browser...');
      braveController = new BraveController();
      await braveController.initialize();
      console.log('✅ Brave browser initialized');
    }

    // Execute the tool
    console.log(`🔧 Executing tool: ${toolName}`);
    const result = await trackInFlight(() => tool.execute(braveController, params));
    
    res.json({
      success: true,
      tool: toolName,
      result: result,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Tool execution error:', redactUrls(error.message));
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// MCP Protocol endpoint with better error handling
app.get('/mcp', (req, res) => {
  // Handle GET requests - return server info
  res.json({
    server: 'brave-mcp-server',
    version: '2.0.0',
    protocol: 'MCP',
    methods: ['tools/list', 'tools/call'],
    timestamp: new Date().toISOString()
  });
});

app.post('/mcp', async (req, res) => {
  mcpAccessLog(req, res, 'mcp');
  try {
    
    const { method, params, id } = req.body;
    
    if (!method) {
      return res.status(400).json({
        jsonrpc: '2.0',
        id: id ?? null,
        error: {
          code: -32600,
          message: 'Invalid Request: missing method',
          data: { received: req.body }
        }
      });
    }

    // MCP "notifications/*" methods are notifications (no id) — must return 202 No Content.
    if (method.startsWith('notifications/')) {
      return res.status(202).end();
    }

    if (method === 'initialize') {
      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: 'brave-mcp-server',
            version: '2.0.0'
          }
        }
      });
    }

    if (method === 'tools/list') {
      const toolList = tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema
      }));

      return res.json({
        jsonrpc: '2.0',
        id,
        result: { tools: toolList }
      });
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const tool = tools.find(t => t.name === toolName);

      if (!tool) {
        return res.status(404).json({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Tool ${toolName} not found`,
            data: { availableTools: tools.map(t => t.name) }
          }
        });
      }

      // Initialize browser if needed
      if (!braveController) {
        console.log('🚀 Initializing Brave browser...');
        braveController = new BraveController();
        await braveController.initialize();
      }

      console.log(`🔧 Executing tool: ${toolName}`);
      // MCP standard: params = { name, arguments }; tools expect arguments-t.
      // 2026-05-10 fix — addig az egész params-ot adta át, így pl. a brave_scrape
      // params.url helyett params.arguments.url-ben kapta az URL-t és undefined volt.
      // 2026-05-14: wrap in TOOL_CALL_TIMEOUT_MS so a single stuck Puppeteer
      // page can't hang the request 30+s. Returns explicit JSONRPC -32000.
      const args = params?.arguments ?? {};
      // 2026-09-23: tool-szintű határidő (lásd tool-timeout.js) — a brave_scrape
      // flaresolverr/auto_fallback útja 160 s-ot kap, minden más marad 25 s.
      const callTimeoutMs = toolTimeoutMs(toolName, args);
      let result;
      try {
        result = await trackInFlight(() => withTimeout(
          tool.execute(braveController, args),
          callTimeoutMs,
          `tools/call ${toolName}`
        ));
      } catch (err) {
        if (String(err.message || '').includes('timeout')) {
          console.error(`⏱️ Tool ${toolName} timed out after ${callTimeoutMs}ms`);
          return res.status(504).json({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32000,
              message: `Tool ${toolName} timeout after ${callTimeoutMs}ms`,
              data: { tool: toolName, timeout_ms: callTimeoutMs }
            }
          });
        }
        throw err;
      }

      return res.json({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
            }
          ]
        }
      });
    }

    res.status(400).json({
      jsonrpc: '2.0',
      id: id ?? null,
      error: {
        code: -32601,
        message: 'Method not found',
        data: { method, availableMethods: ['initialize', 'tools/list', 'tools/call'] }
      }
    });

  } catch (error) {
    console.error('❌ MCP Error:', redactUrls(error?.message || String(error)));
    res.status(500).json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: {
        code: -32603,
        message: error.message
      }
    });
  }
});

// Static files for testing
app.use('/static', express.static('public'));

// SSL tanúsítványok betöltése
let server;
try {
  const fs = require('fs');
  const sslOptions = {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem')
  };
  
  // HTTPS szerver
  server = https.createServer(sslOptions, app).listen(PORT, () => {
    console.log(`🔐 Brave MCP HTTPS Server running on https://localhost:${PORT}`);
    console.log(`📋 Available endpoints:`);
    console.log(`   GET  /health - Health check`);
    console.log(`   GET  /tools - List all tools`);
    console.log(`   POST /tools/:toolName - Execute specific tool`);
    console.log(`   POST /mcp - MCP protocol endpoint`);
    console.log(`   GET  /static - Static files for testing`);
    console.log(`⚠️  Note: Self-signed certificate - accept security warning in browser`);
  });
} catch (error) {
  // Fallback HTTP szerver ha nincs SSL
  console.log('⚠️  SSL certificates not found, falling back to HTTP');
  server = app.listen(PORT, () => {
    console.log(`🌐 Brave MCP HTTP Server running on http://localhost:${PORT}`);
    console.log(`📋 Available endpoints:`);
    console.log(`   GET  /health - Health check`);
    console.log(`   GET  /tools - List all tools`);
    console.log(`   POST /tools/:toolName - Execute specific tool`);
    console.log(`   POST /mcp - MCP protocol endpoint`);
    console.log(`   GET  /static - Static files for testing`);
  });
}

// WebSocket server for real-time communication
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  console.log('🔌 WebSocket client connected');
  
  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('📨 WebSocket message:', _safeTok(message.method));
      
      if (message.method === 'tools/list') {
        const toolList = tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }));
        
        ws.send(JSON.stringify({
          id: message.id,
          result: { tools: toolList }
        }));
        return;
      }
      
      if (message.method === 'tools/call') {
        const toolName = message.params?.name;
        const tool = tools.find(t => t.name === toolName);
        
        if (!tool) {
          ws.send(JSON.stringify({
            id: message.id,
            error: { code: -32601, message: `Tool ${toolName} not found` }
          }));
          return;
        }

        // Initialize browser if needed
        if (!braveController) {
          braveController = new BraveController();
          await braveController.initialize();
        }

        // MCP standard: params = { name, arguments }; ugyanaz a fix mint a HTTP ágon.
        const args = message.params?.arguments ?? {};
        const result = await trackInFlight(() => tool.execute(braveController, args));
        
        ws.send(JSON.stringify({
          id: message.id,
          result: {
            content: [
              {
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
              }
            ]
          }
        }));
      }
      
    } catch (error) {
      ws.send(JSON.stringify({
        id: message.id || null,
        error: { code: -32603, message: error.message }
      }));
    }
  });
  
  ws.on('close', () => {
    console.log('🔌 WebSocket client disconnected');
  });
});

// Graceful shutdown — SIGTERM IS (Railway/konténer-restart SIGTERM-et küld, nem
// SIGINT-et!). Ha a browser.close() kimarad, a Chromium gyerekek árván maradnak
// (snap profil-lock / leaked process / OOM). Ezért MINDKÉT jelre zárunk rendesen.
let _shuttingDown = false;
const gracefulShutdown = async (sig) => {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`🛑 ${sig} — Shutting down server...`);

  if (braveController) {
    try { await braveController.close(); } catch (e) { console.error('browser close hiba:', e); }
  }

  server.close(() => {
    console.log('✅ Server shut down gracefully');
    process.exit(0);
  });
  // Hard-fallback: ha a server.close() beragad, 5s után kilépünk (a gyerekek
  // így is záródtak a browser.close()-zal).
  setTimeout(() => process.exit(0), 5000).unref();
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// 2026-09-22: a puppeteer-extra stealth plugin (user-agent-override evasion) a
// lap létrejöttekor AWAIT NÉLKÜL küld CDP-hívást (Network.setUserAgentOverride).
// Ha a lap/kontextus közben zárul (brave_page felugró ablak, gyors one-shot
// hívás, recycle), a rejection kezeletlen marad → Node 18 alapból LEÁLLÍTJA a
// processzt (mérve a teszt-harnessben: "TargetCloseError … Target closed").
// CSAK a „a cél már nincs" osztályt nyeljük (ritkítva naplózva); minden más
// kezeletlen rejection a régi módon öl (exit 1 → Railway restart).
let _lastTargetGoneLog = 0;
process.on('unhandledRejection', (reason) => {
  const msg = String(reason?.message || reason || '');
  if (reason?.name === 'TargetCloseError' ||
      /Target closed|Session closed|Connection closed|No target with given id|Execution context was destroyed/i.test(msg)) {
    if (Date.now() - _lastTargetGoneLog > 60000) {
      _lastTargetGoneLog = Date.now();
      console.warn(`[unhandledRejection] target-gone, nyelve: ${redactUrls(msg).slice(0, 160)}`);
    }
    return;
  }
  console.error('💀 unhandledRejection:', redactUrls(reason?.stack || msg));
  process.exit(1);
});

// ── MEGELŐZŐ ÚJJÁSZÜLETÉS — 2026-07-08 ─────────────────────────────────────
// REBIRTH_AFTER_MS (default 6h) elteltével az első forgalommentes pillanatban
// (nincs in-flight tool-hívás és nincs aktív scrape) graceful exit(0) — a
// Railway restartPolicy (ALWAYS) tiszta konténerrel újraindít. Ha sosem lesz
// üresjárat, REBIRTH_HARD_EXTRA_MS (default +1h) után akkor is kilépünk (az
// in-flight hívásokat a 25s-es TOOL_CALL_TIMEOUT úgyis felülről korlátozza).
// Ez nullázza a node-processz kúszó RSS-ét is, amit a böngésző-recycle nem ér el.
setInterval(() => {
  const age = Date.now() - _bornAt;
  if (age < REBIRTH_AFTER_MS) return;
  const activeScrapes = braveController ? braveController._scrapeGate.active : 0;
  // 2026-09-22: élő brave_page munkamenet (hívások közt is) = nem üresjárat;
  // a hard-deadline így is érvényes.
  const pageSessions = braveController?._pageMgr ? braveController._pageMgr.size() : 0;
  const idle = _inFlight === 0 && activeScrapes === 0 && pageSessions === 0;
  if (idle || age > REBIRTH_AFTER_MS + REBIRTH_HARD_EXTRA_MS) {
    console.log(
      `♻️ REBIRTH — tervezett újjászületés: uptime=${Math.round(age / 60000)}min, ` +
      `in_flight=${_inFlight}, active_scrapes=${activeScrapes}${idle ? '' : ' (hard-deadline)'} — graceful exit(0)`
    );
    gracefulShutdown('REBIRTH');
  }
}, 30000).unref();

export { app, server };