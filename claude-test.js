import { BraveController } from './src/brave-controller.js';
import dotenv from 'dotenv';

dotenv.config();

async function claudeTest() {
  console.log('🤖 Claude Code teszt - Brave MCP Server');
  console.log('📋 Feladat: index.hu megnyitása és Orbán hírek keresése');
  
  const controller = new BraveController();
  
  try {
    console.log('\n🚀 Brave böngésző inicializálása...');
    await controller.initialize();
    console.log('✅ Brave sikeresen inicializálva!');
    
    // 1. Index.hu megnyitása és scrape-elése
    console.log('\n📰 Index.hu megnyitása...');
    const indexResult = await controller.scrape('https://index.hu', { 
      screenshot: false,
      waitUntil: 'domcontentloaded',
      timeout: 15000,
      includeLinks: true
    });
    
    console.log(`✅ Index.hu betöltve: ${indexResult.title}`);
    console.log(`📊 Találtam ${indexResult.links?.length || 0} linket`);
    
    // Keressünk Orbán-nal kapcsolatos cikkeket a linkek között
    const orbanLinks = indexResult.links?.filter(link => 
      link.text.toLowerCase().includes('orbán') || 
      link.href.toLowerCase().includes('orban')
    ) || [];
    
    console.log(`🔍 Orbán-nal kapcsolatos linkek az index.hu-n: ${orbanLinks.length}`);
    orbanLinks.slice(0, 3).forEach((link, i) => {
      console.log(`   ${i+1}. ${link.text} - ${link.href}`);
    });
    
    // 2. Brave Search használata Orbán hírekre
    console.log('\n🔎 Brave Search - Orbán hírek keresése...');
    const searchResult = await controller.search('Orbán Viktor hírek magyarország', { 
      limit: 5 
    });
    
    console.log(`✅ Brave Search eredmények: ${searchResult.results.length}`);
    searchResult.results.forEach((result, i) => {
      console.log(`\n📰 ${i+1}. ${result.title}`);
      console.log(`🔗 ${result.url}`);
      console.log(`📝 ${result.description.substring(0, 100)}...`);
    });
    
    // 3. Egy konkrét hír cikk scrape-elése
    if (searchResult.results.length > 0) {
      console.log('\n📖 Első hír cikk részletes scrape-elése...');
      const firstNewsUrl = searchResult.results[0].url;
      
      try {
        const articleResult = await controller.scrape(firstNewsUrl, { 
          screenshot: false,
          timeout: 10000,
          waitUntil: 'domcontentloaded'
        });
        
        console.log(`✅ Cikk betöltve: ${articleResult.title}`);
        console.log(`📄 Cikk szöveg (első 300 karakter):`);
        console.log(articleResult.text.substring(0, 300) + '...');
        
      } catch (articleError) {
        console.log(`⚠️ Cikk scrape hiba: ${articleError.message}`);
      }
    }
    
    console.log('\n🎉 Claude Code teszt sikeresen befejezve!');
    console.log('✨ Brave MCP Server tökéletesen működik Claude Code környezetben!');
    
  } catch (error) {
    console.error(`\n❌ Hiba történt: ${error.message}`);
    console.error('🔧 Ellenőrizd a Brave böngésző elérhetőségét és az internet kapcsolatot');
  } finally {
    await controller.close();
    console.log('🔒 Brave böngésző bezárva');
  }
}

// Test indítása
claudeTest();