import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BraveController } from './brave-controller.js';
import { tools } from './tools.js';
import dotenv from 'dotenv';

dotenv.config();

// Brave controller példány
let braveController = null;

// MCP Server létrehozása
const server = new Server(
  {
    name: 'brave-browser-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Single tools/call handler for all tools
server.setRequestHandler('tools/call', async (request) => {
  try {
    const toolName = request.params?.name;
    const tool = tools.find(t => t.name === toolName);
    
    if (!tool) {
      throw new Error(`Tool ${toolName} not found`);
    }

    // Lazy initialization
    if (!braveController) {
      braveController = new BraveController();
      await braveController.initialize();
    }

    // Tool végrehajtása
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
          text: `Hiba történt: ${error.message}`
        }
      ],
      isError: true
    };
  }
});

// Tool lista handler
server.setRequestHandler('tools/list', async () => ({
  tools: tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }))
}));

// Szerver indítása
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('Brave MCP Server elindult');
  
  // Graceful shutdown
  process.on('SIGINT', async () => {
    if (braveController) {
      await braveController.close();
    }
    process.exit(0);
  });
}

main().catch(console.error);