# Brave Browser MCP Server

Egyszerű MCP szerver Brave böngésző automatizálásához.

## 👥 Contributors

**🚀 Created by:** [Tamas Csizmadia](https://github.com/Tamas54) & Claude Code  
**💡 Concept & Implementation:** Tamas Csizmadia  
**🤖 Development Assistant:** Claude Code

## Telepítés

### 📦 Gyors telepítés
```bash
git clone [repository-url]
cd brave-mcp-server
npm install
cp .env.example .env
npm start
```

### ⚙️ Környezeti változók (.env)
```bash
# Brave böngésző elérési útja (opcionális - automatikus detektálás)
BRAVE_PATH=/snap/bin/brave              # Linux
# BRAVE_PATH=/usr/bin/brave-browser     # Linux alternatív
# BRAVE_PATH=C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe  # Windows

# Böngésző mód
HEADLESS=true                           # true=láthatatlan, false=látható
DEBUG=true                              # részletes logok

# HTTP szerver port (Claude Browser számára)
HTTP_PORT=3002
```

### 🚀 Indítási módok
```bash
# Teljes szerver (HTTP + STDIO)
npm start

# Csak HTTP szerver (Claude Browser)
npm run http

# Csak STDIO szerver (Claude Code/Desktop)  
npm run stdio

# Teszt futtatás
npm run test
```

### 🔍 Telepítés ellenőrzése
```bash
# Brave böngésző ellenőrzése
which brave-browser || which brave || which google-chrome

# Szerver health check
curl http://localhost:3002/health

# Teszt futtatás Claude Code-ban
node claude-test.js
```

## Konfiguráció

### Claude Desktop & Claude Code (STDIO):
```json
{
  "mcpServers": {
    "brave-browser": {
      "command": "node",
      "args": ["/path/to/brave-mcp-server/src/dual-server.js"],
      "env": {
        "BRAVE_PATH": "/usr/bin/brave-browser",
        "HEADLESS": "true"
      }
    }
  }
}
```

### Claude Browser (HTTP MCP Server):

#### 🚀 Production (Railway):
**Remote MCP Server URL:**
```
https://brave-mcp-server-production.up.railway.app/mcp
```

**OAuth beállítások:**
- **Client ID:** `brave-mcp-client`
- **Client Secret:** `brave-mcp-secret` (opcionális)

#### 🏠 Local development:
```bash
npm run http
```

**Local MCP Server URL:**
```
https://localhost:3002/mcp
```

**Note:** Lokálisan self-signed certificate-et használ - fogadd el a böngésző biztonsági figyelmeztetését.

## 🚀 Deployment

### Railway (Ajánlott)

1. **Fork/Clone** a GitHub repository-t
2. **Railway Dashboard** → "Deploy from GitHub"
3. **Select** `Tamas54/brave-mcp-server`
4. **Environment Variables:**
   ```
   HEADLESS=true
   NODE_ENV=production
   PORT=3000
   ```
5. **Deploy** - Railway automatikusan felismeri a Dockerfile-t

**Production URL:** `https://[app-name].railway.app/mcp`

### Docker

```bash
# Build
docker build -t brave-mcp-server .

# Run
docker run -p 3000:3000 -e HEADLESS=true brave-mcp-server
```

### Manual Deployment

```bash
# Production setup
npm ci --only=production
export NODE_ENV=production
export HEADLESS=true
export HTTP_PORT=3000
npm start
```

## Használat

### 🎯 Alapvető parancsok

#### Web Scraping
```
Scrape-eld le a https://index.hu oldalt a brave_scrape tool-lal
```
```
Nyisd meg az index.hu-t és keress Orbán-nal kapcsolatos híreket a brave_scrape tool-lal, includeLinks=true paraméterrel
```

#### Keresés
```
Keress rá "Orbán Viktor hírek" kifejezésre a Brave search-ben a brave_search tool-lal
```
```
Használd a brave_search tool-t "MCP protocol" keresésre, limit=5 paraméterrel
```

#### Crawling
```
Crawl-old végig a https://example.com domain-t maximum 20 oldallal a brave_crawl tool-lal
```

#### Screenshots
```
Készíts screenshot-ot a https://index.hu oldalról a brave_scrape tool-lal screenshot=true paraméterrel
```

### 🔐 Bejelentkezés és Session kezelés

#### Login példák
```
Jelentkezz be a Gmail-embe a brave_login tool-lal. site='gmail', credentials={username: 'example@gmail.com', password: '[jelszó]'}
```
```
Login to my Facebook account using brave_login tool. site='facebook', credentials={username: 'email@example.com', password: 'password'}
```

#### Custom site login
```
Jelentkezz be erre az oldalra: https://mycompany.com/login a brave_login tool-lal site='custom', customUrl='https://mycompany.com/login' paraméterekkel
```

#### Session műveletek
```
Használd a brave_session_action tool-t: site='gmail', action='read_emails' - mutasd az első 10 email-t
```
```
Küldj emailt a brave_session_action tool-lal: site='gmail', action='send_email', parameters={to: 'friend@example.com', subject: 'Hello', body: 'Test message'}
```
```
Listázd az aktív session-öket a brave_list_sessions tool-lal
```
```
Töröld a Facebook session-t a brave_clear_sessions tool-lal site='facebook' paraméterrel
```
```
Töröld az összes session-t: brave_clear_sessions site='all' paraméterrel
```

### 🤖 Fejlett automatizálás

#### Visual CAPTCHA kezelés
```
Készíts screenshot-ot a CAPTCHA-ról: brave_visual_captcha action='capture'
```
```
Kattints a CAPTCHA koordinátáira: brave_visual_captcha action='click', coordinates={x: 150, y: 200}
```
```
Írj be CAPTCHA szöveget: brave_visual_captcha action='type', text='A8B3K9'
```

#### Egér kontroll
```
Mozgasd az egeret: brave_mouse_control action='move', x=400, y=300
```
```
Kattints egy gombra: brave_mouse_control action='click', x=580, y=120
```
```
Húzd el egy elemet: brave_mouse_control action='drag', x=100, y=200, targetX=400, targetY=200
```
```
Készíts screenshot-ot kurzorral: brave_mouse_control action='screenshot_with_cursor', x=300, y=400
```

#### Vizuális elem felismerés
```
Elemezd az oldal összes kattintható elemét: brave_visual_inspect mode='full_analysis'
```
```
Keresd meg a 'Login' gombot: brave_visual_inspect mode='find_element', query='login'
```
```
Készíts interaktív térképet számozott elemekkel: brave_visual_inspect mode='interactive_map'
```

#### Custom JavaScript
```
Használd a brave_session_action tool-t custom JavaScript-tel: site='gmail', action='custom', customScript='return document.querySelectorAll(".zA").length' - megszámolja az email-eket
```

### 📋 Teszt parancsok

#### Gyors teszt
```bash
npm run test
```

#### Teljes funkció teszt (Claude Code)
```bash
node claude-test.js
```

#### HTTP API teszt
```bash
curl https://localhost:3002/health
curl https://localhost:3002/tools
curl -X POST https://localhost:3002/tools/brave_scrape -H "Content-Type: application/json" -d '{"url":"https://example.com"}'
```

## Funkciók

- Weboldal scrape-elés markdown formátumba
- Multi-page crawling
- Brave Search integráció
- Screenshot készítés
- Stealth mód anti-bot védelem ellen
- Metadata kinyerés
- **Login automatizálás** (Gmail, Facebook, Twitter, LinkedIn, Instagram)
- **Session management** - egyszer bejelentkezve többször használható
- **2FA támogatás** - TOTP kódok kezelése
- **Custom site login** - bármilyen oldal automatikus felismerése
- **Session alapú műveletek** - email olvasás, üzenet küldés, stb.

## Visual Control & Mouse Integration

### Új képességek:

- **Visual CAPTCHA Solving**
  - Screenshot készítés CAPTCHA területről
  - Elemek koordinátáinak meghatározása
  - Precíz kattintás és szövegbevitel
  - AI-alapú CAPTCHA felismerés támogatása

- **Teljes egér kontroll**
  - Emberi egérmozgás szimuláció (Bézier görbe)
  - Kattintás, dupla kattintás, jobb klikk
  - Drag & drop műveletek
  - Hover effektek
  - Kurzor pozíció követés

- **Vizuális elem felismerés**
  - Teljes oldal interaktív elem analízis
  - Szöveg alapú elem keresés
  - Interaktív térkép számozott elemekkel
  - Screenshot-ok vizuális jelölésekkel

## Használati workflow példa CAPTCHA-val:

```
1. Claude: "Van CAPTCHA az oldalon?"
   → brave_visual_captcha action='capture'
   → Screenshot megjelenítése koordinátákkal

2. Claude elemzi a képet: "Látom, válaszd ki a zebrát"
   → brave_mouse_control action='click' x=120 y=150
   → brave_mouse_control action='click' x=250 y=150

3. Claude: "Kattints a Submit gombra"
   → brave_visual_inspect mode='find_element' query='submit'
   → brave_mouse_control action='click' x=400 y=350
```

## Példa teljes workflow:

```
User: "Claus, jelentkezz be a Gmail fiókodba"
Claus: [brave_login használata]
       "Bejelentkeztem, de CAPTCHA védelem van!"
       [brave_visual_captcha action='capture']
       "Itt a képernyőkép. Látom hogy 'Select all traffic lights' feladat."
       
User: "A bal felső és jobb középső képen van közlekedési lámpa"
Claus: [brave_mouse_control action='click' x=120 y=150]
       [brave_mouse_control action='click' x=380 y=150]
       [brave_visual_inspect mode='find_element' query='verify']
       [brave_mouse_control action='click' x=400 y=450]
       "Sikeres bejelentkezés! Mit szeretnél megnézni?"
```

## Biztonsági figyelmeztetések

⚠️ **FONTOS**: 
- Csak saját fiókjaiba jelentkezzen be!
- A szolgáltatók (Google, Facebook, stb.) tilthatják az automatizált bejelentkezést
- Fiók felfüggesztés kockázata áll fenn
- Használjon app-specific jelszavakat ahol lehet
- A session fájlok érzékeny adatokat tartalmaznak - védje őket!
- 2FA használata erősen ajánlott minden fióknál
- Ne ossza meg a session fájlokat senkivel
- Rendszeresen törölje a lejárt session-öket

### Visual Control figyelmeztetések:
- A screenshot-ok tartalmazhatnak érzékeny információkat
- CAPTCHA megoldás etikai és jogi következményekkel járhat
- Egyes szolgáltatók detektálhatják az automatizált egérmozgást
- Használja felelősségteljesen a vizuális kontroll funkciókat

## Session fájlok

A bejelentkezési session-ök a `.sessions/` mappában tárolódnak. Ezek érzékeny adatok!

```bash
# Session fájlok törlése
rm -rf .sessions/
```

## 🛠️ Teljes MCP Tools Lista

### 🌐 Web Automation Tools

#### 1. **brave_scrape** - Weboldal Scraping
Weboldal tartalmának kinyerése Brave böngészővel
- **Paraméterek:** `url` (kötelező), `waitForSelector`, `waitTime`, `screenshot`, `includeHtml`, `includeLinks`
- **Visszaad:** markdown, text, html, metadata, links, screenshot
- **Példa:** `Scrape-eld le a https://index.hu oldalt screenshot=true paraméterrel`

#### 2. **brave_crawl** - Website Crawling  
Több oldal bejárása ugyanazon domain-en
- **Paraméterek:** `startUrl` (kötelező), `maxPages`, `sameDomain`, `includePattern`, `excludePattern`
- **Visszaad:** Crawled pages array with content
- **Példa:** `Crawl-old a https://example.com domain-t maxPages=5 paraméterrel`

#### 3. **brave_search** - Brave Search
Keresés a Brave keresőmotorban
- **Paraméterek:** `query` (kötelező), `limit`
- **Visszaad:** Search results with titles, URLs, descriptions
- **Példa:** `Keress rá "MCP protocol" kifejezésre limit=10 paraméterrel`

### 🔐 Authentication & Session Management

#### 4. **brave_login** - Automated Login
Bejelentkezés népszerű weboldalakra
- **Támogatott oldalak:** Gmail, Facebook, Twitter, LinkedIn, Instagram, Custom sites
- **Paraméterek:** `site`, `credentials` (username, password, totp), `saveSession`, `customUrl`
- **Visszaad:** Login success status, session info
- **Példa:** `Jelentkezz be Gmail-be site='gmail', credentials={username: 'email@gmail.com', password: 'pass'}`

#### 5. **brave_session_action** - Session Operations
Műveletek végrehajtása mentett session-nel
- **Akciók:** `read_emails`, `send_email`, `get_messages`, `post_content`, `custom`
- **Paraméterek:** `site`, `action`, `parameters`, `customScript`
- **Példa:** `Olvass el emaileket: site='gmail', action='read_emails'`

#### 6. **brave_list_sessions** - Session Management
Aktív session-ök listázása és állapotuk
- **Visszaad:** Sessions array with age, status, cookie count
- **Példa:** `Listázd az aktív session-öket`

#### 7. **brave_clear_sessions** - Session Cleanup
Session-ök törlése
- **Paraméterek:** `site` (vagy 'all' az összeshez)
- **Példa:** `Töröld a Gmail session-t site='gmail' paraméterrel`

### 🎮 Visual Control & Automation

#### 8. **brave_visual_captcha** - CAPTCHA Solver
Vizuális CAPTCHA kezelés screenshot alapján
- **Akciók:** `capture` (screenshot), `click` (coordinates), `type` (text input)
- **Paraméterek:** `action`, `coordinates` {x, y}, `text`
- **Példa:** `Készíts CAPTCHA screenshot-ot: action='capture'`

#### 9. **brave_mouse_control** - Mouse Automation
Teljes egér kontroll emberi mozgással
- **Akciók:** `move`, `click`, `doubleClick`, `rightClick`, `drag`, `hover`, `screenshot_with_cursor`
- **Paraméterek:** `action`, `x`, `y`, `targetX`, `targetY`, `duration`
- **Példa:** `Kattints koordinátákra: action='click', x=300, y=200`

#### 10. **brave_visual_inspect** - Element Detection
Vizuális elem felismerés és interakció
- **Módok:** `full_analysis`, `find_element`, `interactive_map`
- **Paraméterek:** `mode`, `query` (keresett elem szövege)
- **Visszaad:** Element coordinates, interactive map, analysis
- **Példa:** `Keresd meg a 'Login' gombot: mode='find_element', query='login'`

## 🎯 Gyors példák minden tool-ra

### Web Scraping
```
Scrape-eld le a https://index.hu oldalt és keress Orbán-nal kapcsolatos híreket
```

### Keresés  
```
Keress rá "Claude AI latest news" kifejezésre a Brave search-ben
```

### Bejelentkezés
```
Jelentkezz be a Gmail fiókodba és mentsd el a session-t
```

### Email olvasás
```
Olvass el 5 emailt a Gmail-ből a mentett session-nel
```

### Visual automation
```
Készíts screenshot-ot az oldalról és keresd meg a "Submit" gombot
```