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

## 🛡️ Egress-szűrő (SSRF-védelem, 2026-09-22)

A Chromium MINDEN forgalma egy folyamaton belüli forward proxyn megy
(`127.0.0.1:<véletlen port>`, `src/egress.js`). A proxy maga oldja fel a hostot
(A + AAAA), elutasít minden nem-publikus címet, és a már ellenőrzött IP-re
csatlakozik (DNS-rebinding ellen). Tiltva: loopback, privát (10/8, 172.16/12,
192.168/16), link-local + felhő-metadata (169.254/16), CGNAT (100.64/10), 0/8,
192.0.0/24, 198.18/15, dokumentációs tartományok, multicast, 240/4, broadcast,
IPv6 ULA (fc00::/7 — a Railway belső hálója), link-local, loopback, unspecified,
és minden IPv4-et beágyazó IPv6-alak (::ffff:0:0/96, 64:ff9b::/96 NAT64, ::/96,
2002::/16 6to4, 2001::/32 Teredo) a beágyazott v4 szerint. Csak `http/https`
navigáció (a `file://` a szerver env-jét adná ki).

- A Chrome launch-flagjei: `--proxy-server=http://127.0.0.1:<port>`,
  `--proxy-bypass-list=<-loopback>` (enélkül a localhostot megkerülné),
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, `--disable-quic`.
- Tiltott kérés: a proxy `403`-at ad `X-Brave-Egress-Blocked: <ok>` fejléccel.
  `brave_scrape` → `{error:"egress_blocked", content_usable:false, blocked:{reason}}`;
  `brave_page` → `blocked: {reason}`; `brave_navigate` → `egress_blocked:<ok>` hiba.
- A Webclaw / FlareSolverr útvonal előtt is ellenőrzünk (a Webclaw a konténerben
  fut, a FlareSolverr a belső hálón) — ezek viszont maguk oldanak fel, így náluk a
  DNS-rebinding elméletileg nyitva marad.
- Node-oldali letöltés (Wayback-API) is az ellenőrzött úton (`safeFetch`).

| env | default | jelentés |
|---|---|---|
| `BRAVE_EGRESS_FILTER` | `1` | `0` = kill-switch: nincs proxy, régi viselkedés |
| `BRAVE_EGRESS_DNS_CACHE_MS` | `30000` | ellenőrzött DNS-válaszok gyorsítótára |
| `BRAVE_EGRESS_CONNECT_TIMEOUT_MS` | `10000` | upstream TCP-connect plafon |
| `BRAVE_EGRESS_IDLE_TIMEOUT_MS` | `300000` | tétlen tunnel/stream bontása |
| `BRAVE_EGRESS_ALLOW_TEST_LOOPBACK` | – | CSAK teszthez: `1` + `NODE_ENV=test` + nincs `RAILWAY_*` env → a 127.0.0.0/8 és ::1 engedett (élesben a Dockerfile `NODE_ENV=production`-je miatt nem kapcsolhat be) |

Mért többletidő (lokál, 7 valós oldal, medián): brave_scrape +~70 ms, brave_page +~100 ms oldalanként.

## 🧭 brave_page — izolált böngésző-lap Firecrawl-actionökkel

Minden hívás (vagy munkamenet) saját inkognitó `BrowserContext`-ben fut: nem látja
a scrape-sáv sütijeit, a `brave_login` munkameneteit, sem más munkamenetet.
Letöltés tiltva, felugró ablak zárva, `alert/confirm` automatikusan lezárva.
A hívás a meglévő concurrency-limiten (`BRAVE_MAX_CONCURRENCY`) osztozik, és a
25 s-os `TOOL_CALL_TIMEOUT_MS` alatt saját határidővel részleges eredményt ad.

**Bemenet** (a teljes szerződés: `KONTRAKTUS.md`, „brave-mcp ÚJ tool: brave_page"):

```json
{
  "url": "https://example.com",
  "keep_session": true,
  "actions": [
    {"type": "click", "text": "Elfogadom"},
    {"type": "write", "selector": "#q", "text": "budapest"},
    {"type": "press", "key": "Enter"},
    {"type": "wait", "selector": ".results"},
    {"type": "scroll", "direction": "down", "amount": 1200},
    {"type": "screenshot", "fullPage": true, "quality": 70},
    {"type": "executeJavascript", "script": "return document.title"},
    {"type": "generatePDF", "format": "A4"},
    {"type": "scrape"}
  ],
  "formats": ["html", "text", "links", "screenshot"],
  "mobile": false, "locale": "hu-HU", "timezone": "Europe/Budapest",
  "headers": {"X-Foo": "bar"}, "block_ads": true, "wait_ms": 0, "timeout_ms": 25000,
  "profile": {"name": "owner:myprofile", "save_changes": true}
}
```

Action-típusok: `wait {milliseconds?, selector?}`, `click {selector? | text? | x,y; all?}`,
`write {text, selector?}`, `press {key}`, `scroll {direction, amount?, selector?}`,
`screenshot {fullPage?, quality?, viewport?}`, `scrape`, `executeJavascript {script}`
(CSAK a lapban fut — `page.evaluate`; `return` esetén függvénytestként),
`generatePDF` / `pdf {format?, landscape?, scale?}`, `navigate {url}`.
Az első hibás action után a többi `skipped`.

**Kimenet** (a tool `content[0].text` JSON-ja):
`{ok, session_id, url, final_url, status, title, html, text, links, screenshot,
action_results[{type, ok, error?, screenshot?, html?, url?, js_result?, js_type?, pdf?, clicked?, status?}],
blocked: {reason}|null, warnings[], elapsed_ms, error}` — minden vágás/kizárás
(pl. `screenshot_quality_reduced`, `html_truncated`, `block_ads: N request(s) blocked`,
`egress_blocked_subresources`, `popup_closed`) a `warnings`-ban látszik.

**Munkamenetek:** `keep_session: true` → 128 bites `session_id`; tétlen TTL 300 s,
abszolút 30 perc, egyszerre max `BRAVE_PAGE_MAX_SESSIONS` (4). A munkamenet a
hívások között NEM foglal concurrency-slotot. Böngésző-recycle élő munkamenet
alatt legfeljebb 20+30 percig halasztódik; utána `session_lost:browser_recycled`.

**Profilok:** az azonos nevű profilok közös sütit + localStorage-t kapnak
(storageState). A nevet a hívó névtere adja (az Echolot Engine `<owner>:<név>`
alakban küldi). Egyszerre egy munkamenet menthet egy profilt (a többi csak olvas,
warninggal). Tárolás: `BRAVE_PAGE_PROFILE_DIR` (default `.sessions/page-profiles/`,
fájlnév = a név SHA-256-ja), LRU max `BRAVE_PAGE_MAX_PROFILES` (50).
**Deploykor/konténer-cserekor a profilok elveszhetnek** (nincs volume).

| env | default |
|---|---|
| `BRAVE_PAGE_MAX_SESSIONS` | `4` |
| `BRAVE_PAGE_IDLE_TTL_MS` / `BRAVE_PAGE_ABS_TTL_MS` | `300000` / `1800000` |
| `BRAVE_PAGE_MAX_PROFILES` / `BRAVE_PAGE_PROFILE_DIR` | `50` / `.sessions/page-profiles` |
| `BRAVE_PAGE_SCREENSHOT_MAX_B64` | `1500000` (JPEG; minőség-lépcső 80→60→40→25, majd kicsinyítés) |
| `BRAVE_PAGE_FULLPAGE_MAX_HEIGHT` | `10000` px |
| `BRAVE_PAGE_PDF_MAX_B64` / `BRAVE_PAGE_MAX_HTML_CHARS` | `5000000` / `2000000` |

**Tesztek:** `npm run test:node` (= `node --test test/`). A böngészős tesztek
`BRAVE_PATH`-ot vagy egy telepített Chrome/Brave-et keresnek; a publikus részek
hálózat nélkül kimaradnak.

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