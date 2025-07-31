# Brave Browser MCP Server

Egyszerű MCP szerver Brave böngésző automatizálásához.

## 👥 Contributors

**🚀 Created by:** [Tamas54](https://github.com/Tamas54) & Claude Code  
**💡 Concept & Implementation:** Tamás  
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

### Claude Browser (HTTP API):
Indítsd el a szervert HTTP módban:
```bash
npm run http
```

Aztán használd a HTTP API-t:
- **Health check**: `GET http://localhost:3001/health`
- **Tools lista**: `GET http://localhost:3001/tools`
- **Tool végrehajtás**: `POST http://localhost:3001/tools/{toolName}`
- **Teszt oldal**: `http://localhost:3001/static/test.html`

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

## Teljes eszköz lista

1. **brave_scrape** - Weboldal scrape-elés (markdown, HTML, screenshot)
2. **brave_crawl** - Domain crawling több oldalon keresztül  
3. **brave_search** - Keresés Brave Search-ben
4. **brave_login** - Bejelentkezés weboldalakra (Gmail, Facebook, Twitter, LinkedIn, Instagram, custom)
5. **brave_session_action** - Műveletek végrehajtása bejelentkezett session-nel
6. **brave_list_sessions** - Aktív session-ök listázása
7. **brave_clear_sessions** - Session-ök törlése
8. **brave_visual_captcha** - CAPTCHA vizuális kezelése (screenshot, click, type)
9. **brave_mouse_control** - Teljes egér kontroll (move, click, drag, hover)
10. **brave_visual_inspect** - Vizuális elem felismerés és analízis