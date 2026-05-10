import express from 'express';
import cors from 'cors';
import https from 'https';
import { WebSocketServer } from 'ws';
import { BraveController } from './brave-controller.js';
import { tools } from './tools.js';
import dotenv from 'dotenv';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

dotenv.config();

// Brave controller példány
let braveController = null;

const app = express();
const PORT = process.env.PORT || process.env.HTTP_PORT || 3000;

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
  console.log('🔐 OAuth token request:', req.body);
  
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
  console.log('🔐 OAuth authorize request:', req.query);
  
  const { client_id, redirect_uri, response_type, state } = req.query;
  
  if (response_type === 'code') {
    const code = 'brave-auth-code-' + Math.random().toString(36).substr(2, 9);
    const redirectUrl = `${redirect_uri}?code=${code}${state ? `&state=${state}` : ''}`;
    console.log('🔐 Redirecting to:', redirectUrl);
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

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    server: 'brave-mcp-server',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    auth: 'optional'
  });
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
    const result = await tool.execute(braveController, params);
    
    res.json({
      success: true,
      tool: toolName,
      result: result,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Tool execution error:', error.message);
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
  try {
    console.log('🔧 MCP Request:', JSON.stringify(req.body, null, 2));
    console.log('🔧 MCP Headers:', req.headers);
    
    const { method, params, id } = req.body;
    
    if (!method) {
      return res.status(400).json({ 
        error: 'Missing method parameter',
        received: req.body 
      });
    }
    
    if (method === 'initialize') {
      return res.json({
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
        id,
        result: { tools: toolList }
      });
    }
    
    if (method === 'tools/call') {
      const toolName = params?.name;
      const tool = tools.find(t => t.name === toolName);
      
      if (!tool) {
        return res.status(404).json({ 
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
      const args = params?.arguments ?? {};
      const result = await tool.execute(braveController, args);
      
      return res.json({
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
      id,
      error: {
        code: -32601,
        message: 'Method not found',
        data: { method, availableMethods: ['tools/list', 'tools/call'] }
      }
    });
    
  } catch (error) {
    console.error('❌ MCP Error:', error);
    res.status(500).json({ 
      id: req.body?.id,
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
      console.log('📨 WebSocket message:', message.method);
      
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
        const result = await tool.execute(braveController, args);
        
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

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('🛑 Shutting down server...');
  
  if (braveController) {
    await braveController.close();
  }
  
  server.close(() => {
    console.log('✅ Server shut down gracefully');
    process.exit(0);
  });
});

export { app, server };