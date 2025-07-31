import { BraveController } from './src/brave-controller.js';
import dotenv from 'dotenv';

dotenv.config();

async function test() {
  console.log('🚀 Brave MCP Server teszt indítása...');
  
  const controller = new BraveController();
  
  try {
    console.log('📂 Brave böngésző inicializálása...');
    await controller.initialize();
    console.log('✅ Brave sikeresen inicializálva!');
    
    console.log('🌐 Weboldal scrape teszt...');
    const scrapeResult = await controller.scrape('https://example.com', { 
      screenshot: false,
      waitUntil: 'domcontentloaded',
      timeout: 10000
    });
    console.log('Scrape eredmény:', scrapeResult.title);
    
    console.log('🔍 Brave Search teszt...');
    const searchResult = await controller.search('test', { limit: 2 });
    console.log('Keresési eredmények:', searchResult.results.length);
    
    console.log('✅ Minden teszt sikeres!');
    
  } catch (error) {
    console.error('❌ Hiba történt:', error.message);
  } finally {
    await controller.close();
    console.log('🔒 Böngésző bezárva');
  }
}

test();