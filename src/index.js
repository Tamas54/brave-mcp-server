// Simplified STDIO MCP Server using direct approach
import { BraveController } from './brave-controller.js';
import { tools, toolListEntry } from './tools.js';
import dotenv from 'dotenv';

dotenv.config();

let braveController = null;

// Simple JSON-RPC 2.0 handler
//
// Két dolgot KELL betartani, különben a hivatalos MCP SDK-t használó kliensek
// (LM Studio, Claude Desktop) elhasalnak a kézfogáson:
//  1. NOTIFICATION-re (nincs `id`) SOHA nem szabad válaszolni — az MCP a
//     `notifications/initialized`-et közvetlenül az initialize után küldi.
//  2. A stdin CHUNK-okban érkezik, nem sorokban: egy hosszabb tools/call
//     paraméter kettévágódhat két `data` esemény között. Pufferelni kell, és
//     csak a teljes, `\n`-nel lezárt sorokat feldolgozni.
let stdinBuffer = '';
let queue = Promise.resolve(); // sorosítás: egyszerre egy üzenet (lazy-init verseny ellen is)

async function handleMessage(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (parseError) {
    console.error(`❌ Parse error: ${parseError.message}`);
    console.log(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' }
    }));
    return;
  }

  console.error(`📨 Received: ${request.method}`);

  // Notification: elnyeljük némán. Válasz = protokollsértés.
  const isNotification = request.id === undefined || request.id === null;

  let response = { jsonrpc: '2.0', id: request.id };

  try {
    if (request.method === 'tools/list') {
      response.result = {
        // R2-E: ugyanaz a lista-alak, mint a HTTP-ágon (title + annotations hintek)
        tools: tools.map(toolListEntry)
      };
    }
    else if (request.method === 'tools/call') {
      const toolName = request.params?.name;
      const tool = tools.find(t => t.name === toolName);

      if (!tool) {
        throw new Error(`Tool ${toolName} not found`);
      }

      // Lazy initialization
      if (!braveController) {
        console.error('🚀 Initializing Brave browser...');
        braveController = new BraveController();
        await braveController.initialize();
        console.error('✅ Brave browser ready');
      }

      console.error(`⚡ Executing: ${toolName}`);
      // MCP standard: params = { name, arguments }; tools expect arguments-t.
      // Ugyanaz a fix, mint a HTTP ágon (http-server.js, 2026-05-10) — a stdio
      // belépő addig az egész params-ot adta át, így pl. a brave_scrape
      // params.url helyett params.arguments.url-ben kapta az URL-t és undefined volt.
      const args = request.params?.arguments ?? {};
      const result = await tool.execute(braveController, args);

      response.result = {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
          }
        ]
      };
    }
    else if (request.method === 'initialize') {
      response.result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'brave-mcp-server', version: '2.0.0' }
      };
    }
    else if (isNotification) {
      // Ismeretlen notification (pl. notifications/cancelled) — nyugtázás nélkül eldobjuk.
      console.error(`🔕 Notification eldobva: ${request.method}`);
      return;
    }
    else {
      const err = new Error(`Unknown method: ${request.method}`);
      err.code = -32601; // Method not found
      throw err;
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    response.error = { code: error.code ?? -32603, message: error.message };
  }

  if (isNotification) return; // ide csak ismert notification juthat — arra sem válaszolunk
  console.log(JSON.stringify(response));
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  stdinBuffer += data;

  let newlineIndex;
  while ((newlineIndex = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, newlineIndex).trim();
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    if (!line) continue;
    queue = queue.then(() => handleMessage(line));
  }
});

console.error('🚀 Brave MCP STDIO Server started');
console.error('📡 Waiting for JSON-RPC requests...');

// Graceful shutdown — SIGTERM IS (supervisor/konténer SIGTERM-et küld), különben
// a Chromium gyerekek árván maradnak.
let _shuttingDown = false;
const shutdown = async (sig) => {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.error(`🛑 ${sig} — Shutting down...`);
  if (braveController) {
    try { await braveController.close(); } catch (e) { console.error('browser close hiba:', e); }
  }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));