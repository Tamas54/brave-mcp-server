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
