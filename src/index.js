// Simplified STDIO MCP Server using direct approach
import { BraveController } from './brave-controller.js';
import { tools } from './tools.js';
import dotenv from 'dotenv';

dotenv.config();

let braveController = null;

// Simple JSON-RPC 2.0 handler
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (data) => {
  try {
    const lines = data.toString().split('\n').filter(line => line.trim());
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      const request = JSON.parse(line);
      console.error(`📨 Received: ${request.method}`);
      
      let response = { jsonrpc: '2.0', id: request.id };
      
      try {
        if (request.method === 'tools/list') {
          response.result = {
            tools: tools.map(tool => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema
            }))
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
          const result = await tool.execute(braveController, request.params);
          
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
        else {
          throw new Error(`Unknown method: ${request.method}`);
        }
      } catch (error) {
        console.error(`❌ Error: ${error.message}`);
        response.error = { code: -32603, message: error.message };
      }
      
      console.log(JSON.stringify(response));
    }
  } catch (parseError) {
    console.error(`❌ Parse error: ${parseError.message}`);
    console.log(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' }
    }));
  }
});

console.error('🚀 Brave MCP STDIO Server started');
console.error('📡 Waiting for JSON-RPC requests...');

// Graceful shutdown
process.on('SIGINT', async () => {
  console.error('🛑 Shutting down...');
  if (braveController) {
    await braveController.close();
  }
  process.exit(0);
});