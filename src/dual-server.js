import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BraveController } from './brave-controller.js';
import { tools } from './tools.js';
import './http-server.js'; // Start HTTP server
import dotenv from 'dotenv';

dotenv.config();

// Brave controller példány (STDIO transport számára)
let braveController = null;

console.log('🚀 Starting Brave MCP Dual Server...');
console.log('📡 HTTP Server: http://localhost:3001');
console.log('📝 STDIO Server: ready for MCP clients');

// Check if we should only run HTTP mode
if (process.argv.includes('--http-only')) {
  console.log('🌐 Running in HTTP-only mode');
  // HTTP server already started by import
} else {
  // Start STDIO MCP server
  console.log('🔌 Starting STDIO MCP server...');
  
  // Create simplified MCP server for STDIO
  const server = new Server(
    {
      name: 'brave-browser-mcp',
      version: '2.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Single tools handler for STDIO
  server.setRequestHandler('tools/call', async (request) => {
    try {
      const toolName = request.params?.name;
      const tool = tools.find(t => t.name === toolName);
      
      if (!tool) {
        throw new Error(`Tool ${toolName} not found`);
      }

      // Lazy initialization for STDIO
      if (!braveController) {
        braveController = new BraveController();
        await braveController.initialize();
      }

      const result = await tool.execute(braveController, request.params);
      
      return {
        content: [
          {
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error.message}`
          }
        ],
        isError: true
      };
    }
  });

  // Tools list handler for STDIO
  server.setRequestHandler('tools/list', async () => ({
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  }));

  // Connect STDIO transport
  async function startStdioServer() {
    try {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      console.log('✅ STDIO MCP Server connected');
    } catch (error) {
      console.error('❌ STDIO server error:', error.message);
    }
  }

  // Start STDIO server
  startStdioServer();
}

// Graceful shutdown for STDIO — SIGTERM IS (dev/supervisor SIGTERM-et küld).
// (--http-only módban a braveController null marad, a böngészőt a http-server zárja.)
let _shuttingDown = false;
const shutdown = async (sig) => {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`🛑 ${sig} — Shutting down STDIO server...`);
  if (braveController) {
    try { await braveController.close(); } catch (e) { console.error('browser close hiba:', e); }
  }
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));