# brave-mcp-server — Stability Plan 2026-05-14

**Problem:** A `brave-mcp-server` `tools/call` (különösen `brave_search`)
időnként **30-60 másodperces timeout + 0 byte response**-szal akad meg.
A `/health` endpoint továbbra is 200-zal él, de a tényleges JSONRPC
hívások nem kapnak választ. Manuál Railway-restart 30 mp alatt
visszahozza, de Kommandant emberi beavatkozást kíván — nem ok.

**Observed (2026-05-14):**
- Reggel 12:00 körül: brave_search üres response
- Délután 16:00 körül: ugyanaz, restart javította
- Klienseink (Echolot search_web / search_social / scrape_url) ezen
  függnek

## Hipotézisek (sorrendben valószínűség szerint)

### H1: Puppeteer browser-process orphan + memory leak (legvalószínűbb)
A `puppeteer-extra-plugin-stealth` időnként nem zárja le tisztán a
Chromium-példányait — Puppeteer ismert leak. Hosszú-running service-en
ezek a zombi-folyamatok eltöltik a Railway container RAM-ját. Egyetlen
fennakadó `await page.close()` is folyamatosan veszít memóriát.

**Symptom-egyezés**: `/health` (sima HTTP endpoint) él, de minden
`tools/call` ami browser-page-et nyit timeout-ol, mert nincs új page
ami létrejöhetne — connection-pool kimerítve.

### H2: FlareSolverr container drift
A Brave 7-szintű chain L4-en a FlareSolverr-t hívja (külön Railway
service). Ha az is hasonlóan memóriát szivárogtat, akkor a `brave_scrape`
L4-szintje akad meg, és ha az `auto_fallback` nem időtúllép, az egész
chain blokkolódik.

### H3: Webclaw side-car wreq/BoringSSL panic
A Webclaw Rust-binary (port 3001) néha "wreq" hibára panic-el. A
brave-mcp-server hívja `WEBCLAW_URL` env-en át. Ha a side-car halott,
és a brave-mcp nem time-outol szigorúan, a fő szál ott ragad.

### H4: Brave Search API kvóta
A `brave_search` tool a tényleges Brave-Search-API-t hívja (kulccsal,
env-vár). Ha a kvóta lejár, a Brave-Search 429-cel vagy üres-200-szal
válaszol, és a server-belső parser elhal. (Itt 30s timeout érdekes
lenne — inkább azonnali hibát várnánk.)

## Megoldás-csomag

### S1: **Self-test health-check** (kötelező)
A jelenlegi `/health` csak egy szöveges 200-as választ ad — semmit nem
mond a `tools/call` állapotáról. Új endpoint `/health/deep` ami:
- 5-másodperces időkorlátos `brave_search('hello', limit=1)` próba
- Ha siker → 200 + cached pozitív státusz (30s TTL)
- Ha timeout/error → 503 a Railway-nek

Railway `healthcheck_path: /health/deep` + `healthcheck_timeout: 10s` →
ha a deep-check fail → Railway automatikusan újraindítja a containert.
Önjavító ciklus.

### S2: **Hard request-timeout a fő handlerben** (kötelező)
A `tools/call`-routot wrap-eljük egy 25-másodperces `Promise.race`-be.
Ha az inner call nem fejeződik be addig, vissza-dobunk egy
**explicit JSONRPC-hibát** (-32000), NEM hagyjuk a klienst 30+s-ig várni.
Plus log-ba írjuk az URL+tool nevét → reproduszálás-támogatás.

### S3: **Periodic browser pool reset** (megelőző)
Egy `setInterval(2 * 60 * 60 * 1000)` (2 óránként) zárja le az aktív
Puppeteer-pool-t és nyit egy újat. A Puppeteer-leak akkumulálódását
megakadályozza. Eseti `try/finally` close-okat is felülvizsgálni.

### S4: **External watchdog** (opcionális, későbbi)
Új különálló mini-service ami percenként megpiszkálja a
`/health/deep`-et. Ha 3× egymás után fail → Railway-API-n trigger-ol
egy restart-ot. Ez `S1+S2`-n túli safety-net.

### S5: **Telemetry → Bridge** (megfigyelési)
A `tools/call`-row egy mini-counter küldjön a Bridge-be (vagy egyszerű
log-grep) — mennyi 25+s-os call, hány restart-trigger, hány OK. Heti
report a Kommandantnak. Ha az S1+S2+S3 működik, a metrikák tisztábbak
lesznek és tudjuk, hány masszív kérdés érkezik.

## Sorrend

1. **Most**: S1 + S2 megírása a `Tamas54/brave-mcp-server` fork-ban,
   commit → Railway auto-deploy, megfigyelni 24-48h
2. **Aztán**: S3 ha az S1+S2 még nem fedi le teljesen
3. **Később**: S4 + S5 ha még előfordul akadás

## Mit kell megerősíteni / cseppentenie kell Kommandantnak

- A brave-mcp-server `Tamas54/brave-mcp-server` repó-ban van (megfelel
  a "sajátból sajátba" elvnek), tehát én tudom módosítani a kódot és
  push-olni (engedéllyel)
- A Railway-deploy auto-pickup-eli a master-changes-et (Brave-mcp
  esetén meg lett konfigurálva 2026-05-12)
- S1+S2 ~30 sor JS, kis kockázat, megéri

## Kapcsolódó memória / doksi

- `brave_mcp_server.md` — architektúra-ref
- `brave_mcp_server_railway_deploy.md` — Railway-konfig
- `brave_mcp_og_fastpath_todo.md` — másik TODO ami már megvan
- `plan20260513.md` — OG-fast-path L0 szint terv
