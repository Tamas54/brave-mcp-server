# Harmadik féltől átvett kód — THIRD_PARTY_NOTICES

Ez a fájl a brave-mcp-server repóba **forrásként** átvett (vendorolt) harmadik féltől származó kódot
és az átvett koncepciókat rögzíti. Az npm-függőségek (`package.json`) licence a saját csomagjukkal
együtt települ, azokat itt nem soroljuk fel — kivéve, ahol a vendorolt kód belőlük ered.

---

## 1. tf-playwright-stealth (TinyFish fork) — `src/stealth/tf-evasions/vendor/`

Bevezetve: 2026-10-07 (TINYFISH PARITY 2.9 — Stealth), kapcsoló: `STEALTH_TF_EVASIONS` (alapból KI).

| | |
|---|---|
| Forrás-repó | https://github.com/tinyfish-io/tf-playwright-stealth |
| Commit | `b1206e7ed847bf02d3aa895c3e09da02db4fd3bd` |
| Licenc | MIT — `Copyright (c) 2020 ASAS1314` (a fork a felső forrás LICENSE-ét változatlanul hordozza) |
| Felső forrás (upstream) | https://github.com/AtuboDad/playwright_stealth @ `43f7433057906945b1648179304d7dbd8eb10874` — MIT, ugyanaz a LICENSE-szöveg (bájtra azonos, ellenőrizve) |
| Eredet | berstend/puppeteer-extra — `packages/puppeteer-extra-plugin-stealth` (MIT, `Copyright (c) 2019 berstend`); a fork README-je szerint „Transplanted from puppeteer-extra-plugin-stealth" |

### Szó szerint átvett fájlok

| Forrásfájl (a fork-ban) | Cél a repóban | sha256 (a forrásfájlé) | Módosítás |
|---|---|---|---|
| `playwright_stealth/js/utils.js` | `src/stealth/tf-evasions/vendor/utils.js` | `5da4900381a4c45fce9db88993834ad812c3a193d76e95b2a112b15ce40f047a` | nincs — csak attribúciós fejléc-komment került elé; a törzs bájtra azonos (a `test/stealth-tf.test.js` ellenőrzi) |
| `playwright_stealth/js/webgl.vendor.js` | `src/stealth/tf-evasions/vendor/webgl.vendor.js` | `a14f0cab3b5e2bac9afd4ed22e4976d5e9d412b878e7a8f57fa919e06fe55b60` | nincs — ugyanígy; az `opts.webgl` értékét a saját wrapperünk (`page-script.js`) adja a persona OS-éből, és az egész egy IIFE-ben, `try/catch`-ben fut |

Megjegyzés: a fork `utils.js`-e — a formázástól és az utolsó két sortól (`utils.init()`) eltekintve — azonos a
`puppeteer-extra-plugin-stealth` 2.11.2 `evasions/_utils/index.js`-ével (Copyright (c) 2019 berstend, MIT;
ellenőrizve prettier-normalizált diffel). A puppeteer-extra-plugin-stealth a brave-mcp futásidejű függősége is.

### Koncepcióként átvett (kód NÉLKÜL, saját implementáció)

| Fork-elem | Saját megfelelő | Mi más |
|---|---|---|
| `properties/_properties.py`, `_navigator_properties.py`, `_header_properties.py`, `_webgl_properties.py`, `js/navigator.userAgent.js` — a koherens „persona" | `src/stealth/tf-evasions/persona.js` | CDP `Network.setUserAgentOverride` + `userAgentMetadata` (valódi `NavigatorUAData`, fejlécek, workerek) JS-getterek helyett; `Win32` / `Linux x86_64` (a fork `Win64` / `Linux x86_x64` hibái nélkül); a futó böngésző verziója (nem véletlen); determinisztikus (nincs véletlen DNT/WebGL/form-factor); a Chromium mai GREASE-algoritmusa; Brave alatt „Brave" márka |
| `js/navigator.languages.js` — a nyelvlista az Accept-Language-ből | persona `acceptLanguage` + `--lang` / `--accept-lang` indítási flag | a fejléc, a `navigator.language(s)`, a worker és az Intl egy forrásból, natívan (JS-getter nélkül) |

### NEM átvett (szándékosan)

- A fork **3 visszalépése** (`~/recon/tinyfish/STEALTH_DIFF.md` 3.2, 3.3, 3.12):
  `navigator.webdriver` `delete`-tel (a valódi Chrome-ban van descriptor és `false`), a feltétel nélküli
  `window.chrome = { runtime: {} }` (a natív `chrome.app/csi/loadTimes` eldobása), és a `hasPlugins = false`
  kényszer (elavult Native Client-lista modern UA mellett).
- A fork statikus extra fejlécei minden kérésre (Referer, Accept, DNT, `sec-ch-ua*` formátumhibákkal), a
  `fake-http-header` véletlen UA-ja, a véletlen WebGL-párok, és az egyetlen kivételkezelés nélküli összefűzött script.
- A fork többi JS-javítása (iframe.contentWindow, navigator.plugins/mimeTypes, permissions, chrome.csi/loadTimes,
  outerdimensions, media.codecs, chrome.runtime): ezek a puppeteer-extra-plugin-stealth 2.11.2-ben már benne
  vannak, amit a brave-mcp eddig is futtatott — újbóli felrakásuk dupla Proxyt jelentene.

### LICENSE (tf-playwright-stealth @ b1206e7 és AtuboDad/playwright_stealth @ 43f7433 — azonos szöveg)

```
MIT License

Copyright (c) 2020 ASAS1314

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### LICENSE (berstend/puppeteer-extra — puppeteer-extra-plugin-stealth, a `utils.js` eredete)

```
The MIT License (MIT)

Copyright (c) 2019 berstend <github@berstend.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 2. invisible_playwright_mcp (feder-cr) — `src/action-diagnose.js` (R2-E, 2026-10-07)

Bevezetve: 2026-10-07 (2. menet, R2-E — böngésző-interakció minősége), ág `r2-interact`. **CSAK a mai (MIT) állapotból**
portolva; a README szerint 2026-09-02 előtt megjelent állapot AGPL-3.0 maradt — régi git-előzményből SEMMI nem került át.

| | |
|---|---|
| Forrás-repó | https://github.com/feder-cr/invisible_playwright_mcp |
| Commit | `b54f0a401421f057e78d410533354fbf402b1580` (0.70.12, 2026-10-06) |
| Licenc | MIT — `Copyright (c) 2024-2026 AIHawk contributors` |

### MIT-port (átírva JS-re / puppeteerre, NEM szó szerint)

| Forrás (a repóban) | sha256 (a forrásfájlé) | Cél a brave-mcp-ben | Mi került át |
|---|---|---|---|
| `src/invisible_playwright_mcp/mcp/actions.py` — `DIAGNOSE_JS`, `NEXT_MOVE`, `next_move()`, `FIELD_STATE_JS`, `what_the_field_kept()` | `863f0804166b70c4d57b1aed95a13edfaf0c0bb9e8eccefb0adbc238c49d2278` | `src/action-diagnose.js` (`diagnoseInPage`, `NEXT_MOVE`, `nextMove`, `fieldStateInPage`, `keptVerdict`) | a diagnózis-mezők (méret, display/visibility, disabled, pointer-events, képernyőn kívül, `covered_by` az elem SAJÁT gyökeréből), a „mit tegyél" mondatok (átfogalmazva, a mi akció-neveinkre), a mező-állapot olvasás és a gépelés-ítélet alakjai |
| `src/invisible_playwright_mcp/mcp/clean.py` — `SECRET_AUTOCOMPLETE` | `454d287ff41f00af0682b7f9295ed992405309defdf8fb3879bfe03bc4686df6` | `src/action-diagnose.js` (`fieldStateInPage` titok-szabálya) | a titok-mező autocomplete-tokenjei (+ `cc-number`) |

Eltérések: `readonly` és 5 pontos takarás-próba (nem csak a középpont); a `kept` gépi kód + rövid mondat; ÉRTÉK soha nem jön
vissza (csak hossz); a puppeteer `$$`/`ElementHandle`, nem Playwright-locator. A fájl fejléc-kommentje hordozza az attribúciót.

### Koncepcióként átvett (saját implementáció)
- trusted-input fegyelem (`_BY_SCRIPT` szelleme): a `_clickHandle` valódi egérrel kattint, takart elemre nem; JS-fallback csak
  `untrusted_click_fallback` warninggal; billentyűzetes `select` / `clear` (`brave-page.js`);
- set-of-marks jelölők a KÉPRE, nem a lap DOM-jába (`brave-controller.js` `markedSnapshot`, a mérés az ő 0-mutációs snapshotjából);
- MCP-higiénia: `title` + read-only/destructive/open-world hint minden toolon, leírás ≤ 1024 karakter, séma-súly kapu.

### NEM átvett (szándékosan, REPORT 6.)
Patchelt Firefox-motor / kitalált identitás, `prep_recaptcha` / perszóna-sütik, viselkedési humanizálás (egérpálya, remegés,
gépelési ritmus), `hold_seconds`, `main`+`support` kettős identitás, headed-Xvfb, keret nélküli read_html, web-UI, fájlfeltöltő.

### LICENSE (feder-cr/invisible_playwright_mcp @ b54f0a4)

```
MIT License

Copyright (c) 2024-2026 AIHawk contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 3. Scrapling (D4Vinci) — `src/challenge.js` (W2 „falon át", 2026-10-07)

Bevezetve: 2026-10-07 (W2), ág `w2-wall`; 2026-10-08-tól a `rel-wall` kiadási ágon is (W2+C2 merge — a
Scrapling-eredetű részek változatlanok; a reCAPTCHA/hCaptcha → C2 átadás saját kód). A korábbi „solve_cloudflare / hide_canvas / block_webrtc — nem vesszük át"
döntést a Kommandant 10-07 éjjel visszavonta (`~/recon/tinyfish/DECISIONS.md` utolsó bejegyzése).

| | |
|---|---|
| Forrás-repó | https://github.com/D4Vinci/Scrapling |
| Commit | `43dee004866e1c46843a9ac293cc1494aa7915d6` (v0.4.15, 2026-10-06) |
| Licenc | BSD-3-Clause — `Copyright (c) 2024, Karim shoair` (a 3. pont szerint a név promócióra nem használható) |

### Portolva (JS-re átírva, NEM szó szerint)

| Forrás | sha256 (a forrásfájlé) | Cél | Mi került át |
|---|---|---|---|
| `scrapling/engines/_browsers/_base.py` — `_detect_cloudflare`, `_challenge_cleared` | `2fae956e1f3af01ab738919f82dcfb238552846047fda2dd9cba6ed199f25aaa` | `src/challenge.js` (`detectChallengeHtml`) | a `cType: '<non-interactive\|managed\|interactive>'` jelölő és a Turnstile-szkript mint challenge-típus |
| `scrapling/engines/_browsers/_stealth.py` — `_cloudflare_solver` | `f75f52325e96f38c59a48de90c2b4cdd7dee3d9a3deb447f43c0d64825ceb263` | `src/challenge.js` (`findCheckbox`, `handleChallenge`) | a challenge-platform-iframe keret-elemének doboza + a checkbox helye (+26..28, +25..27 px), a tartalék szelektorok, ≤ 3 próbálkozás |
| `scrapling/engines/_browsers/_base.py` — `block_webrtc` flagek | (ua.) | `src/brave-controller.js` (`_webrtcBlockArgs`) | `--force-webrtc-ip-handling-policy` + `--webrtc-ip-handling-policy=disable_non_proxied_udp` — az egress-szűrő nélkül is |

### NEM átvett / nem működő
- `hide_canvas` (`--fingerprinting-canvas-image-data-noise`): a flag a Chrome 154 és a Brave 155 binárisában NEM létezik
  (strings-kereséssel ellenőrizve, 2026-10-07) → no-op. Brave alatt a natív farbling végzi ugyanezt (mérve: a canvas-hash
  indításonként más, lapon belül stabil, fő szál = worker); Chrome alatt nincs canvas-zaj (a hash indítások között azonos).
- A `patchright` motor, a `google_search` (hamis Referer), a SQLite-tár — nem.

### LICENSE (D4Vinci/Scrapling @ 43dee00)

```
BSD 3-Clause License

Copyright (c) 2024, Karim shoair

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

---

## 4. invisible_playwright (feder-cr, „stealthfox") — `src/stealth/humanize.js` (W2, 2026-10-07)

Bevezetve: 2026-10-07 (W2), ág `w2-wall`, kapcsoló: `HUMANIZE=1` (alapból KI; a challenge-checkbox kattintása mindig ezt használja).
**CSAK a mai (MIT) állapotból** portolva. (A testvér `invisible_playwright_mcp` README-je szerint ott a 2026-09-02 előtti állapot
AGPL-3.0 maradt — az `invisible_playwright` könyvtárra ilyen kitétel nincs; régi git-előzményből semmi nem került át.)

| | |
|---|---|
| Forrás-repó | https://github.com/feder-cr/invisible_playwright |
| Commit | `9fc1d25b37593baacde1d27e998e155658c85ebf` (0.27.0, 2026-10-06) |
| Licenc | MIT — `Copyright (c) 2026 stealthfox contributors` (a vendorolt `_pw/` Apache-2.0 — abból SEMMI nem került át) |

### Portolva (JS-re átírva, NEM szó szerint)

| Forrás | sha256 (a forrásfájlé) | Cél | Mi került át |
|---|---|---|---|
| `src/invisible_playwright/_motion.py` | `9a87bc7d687bbfdd8659bb52459bf9b84634d53df21fbc3694007245e57f7fdb` | `src/stealth/humanize.js` (`motionStyleForSeed`, `planPath`) | a munkamenet-stílus (mag → minden alakparaméter), a pálya szakaszai és sorrendje: kar-geometriás kontroll-poligon, Fitts-idő log-normál szórással, mintavétel 8 ms-os padlóval (eldobás), Beta-sebességprofil, túllövés + korrekció, kétdimenziós nulla-átlagú remegés, korlátos pixel-ismétlés |
| `src/invisible_playwright/_behaviour.py` | `f854a0e19975149e015e8cba03fa19bab87234328d8fc323bb4908ff06bd9617` | `src/stealth/humanize.js` (`typingPersona`, `planTyping`, `pointerPersona`, `planClick`, `landingPoint`, `initialPointer`) | a gépelő kéz paraméter-tartományai, a digram-hatás (kézváltás / azonos kéz / azonos billentyű), az elgondolkodás, a gombnyomás-dwell, a landolási pont, a kiinduló kurzor-hely |
| `src/invisible_playwright/_pacing.py` | `f9876b661a92c55388bc7296ff3c7bbb2fb432b120aec690ef3e76e0ccb650cd` | `src/stealth/humanize.js` (`HumanInput.move`) | a kézbesítési fegyelem egyszerűsítve: abszolút határidők egy t0-tól, késésnél eldobás csak a „hatótávon" (2× legnagyobb lépés) belül, ≥ 8 ms két esemény között, a végpont mindig megy, a köztes pontok a nézetablakba vágva |

Eltérések: mulberry32 + Box–Muller a Python `random.Random` helyett (mag-reprodukálható, de a Python-kimenettel bitre NEM
egyezik); „munkamenet" = egy böngésző-indítás; a gépelési terv a hívás határidejéhez skálázva (×0,25 alatt a gyors út).
NEM átvett: `_cursor.py` (Juggler-specifikus meghajtó), az idle-epizód-tervező (`plan_idle`) — helyette egy egyszerű
`idle()` mozdulat a challenge-várakozás alatt —, `plan_scroll`, `prep_recaptcha` / perszóna-sütik, a patchelt Firefox.

### LICENSE (feder-cr/invisible_playwright @ 9fc1d25)

```
MIT License

Copyright (c) 2026 stealthfox contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### C2 — saját CAPTCHA-megoldó, böngésző-oldal (brave-mcp `src/captcha/{detect,grid,audio,text,pointer,png,read-path,echolot-provider,util}.js`, 2026-10-07)
NINCS portolt kód: a felismerés, a vezénylés, a PNG-kivágás és a fixture-ök saját írásúak. A reCAPTCHA / hCaptcha
DOM-szelektorai (pl. `#recaptcha-anchor`, `.rc-imageselect-tile`, `.rc-audiochallenge-tdownload-link`, `.prompt-text`,
`.button-submit`) a nyilvános demo-lapok élő DOM-jából mérve (2026-10-07), nem más projektből átvéve.
