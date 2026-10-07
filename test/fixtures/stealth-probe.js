// Stealth-jeldetektor fixtúra (2026-10-07, TINYFISH PARITY 2.9).
//
// Egy helyi (127.0.0.1) oldal, amely a közismert headless/automatizáció-
// detektorok ELLENŐRZÉSEIT futtatja le a lapon, és az eredményt JSON-ként a
// <pre id="out"> elembe írja. A brave-mcp VALÓDI scrape-útján (default /
// stealth szint) olvassuk vissza — így az A/B mérés és a tesztek ugyanazt a
// láncot mérik, amit élesben a hívók kapnak.
//
// MIÉRT saját detektor is (a nyilvános tesztoldalak mellett): a nyilvános
// oldalak (sannysoft, creepjs, …) változnak, lassúak, és nem mondják meg a
// kérés FEJLÉCEIT. Itt a szerver visszatükrözi a ténylegesen kapott
// User-Agent / Accept-Language / sec-ch-ua fejléceket, így a fejléc ↔ JS
// konzisztencia is mérhető.
//
// Minden ellenőrzés: { v: mért érték, bot: true ha bot-gyanús jel }.
// Ez a fájl CSAK mér — semmilyen védelem áttörését nem végzi.

/* eslint-disable no-undef */
// A lapon futó detektor. Szándékosan önálló, globális-mentes IIFE.
const PROBE_SCRIPT = String.raw`
(async () => {
  const R = {};
  const add = (k, v, bot) => { R[k] = { v, bot: !!bot }; };
  const safe = (k, fn) => { try { return fn(); } catch (e) { add(k, 'HIBA: ' + (e && e.message), true); } };
  const nativeRe = /\{\s*\[native code\]\s*\}\s*$/;
  const isNative = (f) => { try { return nativeRe.test(Function.prototype.toString.call(f)); } catch (e) { return false; } };
  const H = window.__PROBE_HEADERS__ || {};
  const ua = navigator.userAgent;
  const uaOS = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android' : /Linux|X11/.test(ua) ? 'Linux' : 'other';
  const uaMajor = (ua.match(/Chrome\/(\d+)/) || [])[1] || '';
  const langsOf = (s) => String(s || '').split(',').map(x => x.split(';')[0].trim()).filter(Boolean);

  // 1) navigator.webdriver — valódi Chrome: false, a descriptor a prototípuson VAN.
  safe('webdriver', () => {
    const d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
    add('webdriver_value', String(navigator.webdriver), navigator.webdriver !== false);
    add('webdriver_descriptor', !!d, !d);
    add('webdriver_getter_native', !!(d && isNative(d.get)), !!d && !isNative(d.get));
  });

  // 2) UA: HeadlessChrome, appVersion, fejléc ↔ JS.
  safe('ua', () => {
    add('ua_headless_token', /HeadlessChrome/.test(ua), /HeadlessChrome/.test(ua));
    add('ua_header_vs_js', (H['user-agent'] || '') === ua ? 'egyezik' : 'ELTÉR: ' + H['user-agent'], !!H['user-agent'] && H['user-agent'] !== ua);
    const av = ua.replace(/^Mozilla\//, '');
    add('appVersion_vs_ua', navigator.appVersion === av ? 'egyezik' : navigator.appVersion, navigator.appVersion !== av);
  });

  // 3) navigator.platform ↔ UA operációs rendszere.
  safe('platform', () => {
    const ok = { Windows: /^Win32$/, macOS: /^MacIntel$/, Linux: /^Linux (x86_64|aarch64|armv)/ }[uaOS];
    add('platform_vs_ua', navigator.platform + ' / UA:' + uaOS, ok ? !ok.test(navigator.platform) : false);
  });

  // 4) navigator.userAgentData (UA-CH) ↔ UA.
  const uad = navigator.userAgentData;
  add('uad_present', !!uad, !uad);
  if (uad) {
    safe('uad', () => {
      const brands = (uad.brands || []).map(b => b.brand + '/' + b.version);
      add('uad_brands_nonempty', brands.join(', ') || '(üres)', brands.length === 0);
      const cr = (uad.brands || []).find(b => /^(Chromium|Google Chrome|Brave|Microsoft Edge)$/.test(b.brand));
      add('uad_major_vs_ua', (cr ? cr.version : '-') + ' vs UA ' + uaMajor, !cr || cr.version !== uaMajor);
      add('uad_platform_vs_ua', (uad.platform || '(üres)') + ' vs UA ' + uaOS, uad.platform !== uaOS);
      add('uad_proto', typeof NavigatorUAData !== 'undefined' && Object.getPrototypeOf(uad) === NavigatorUAData.prototype,
        !(typeof NavigatorUAData !== 'undefined' && Object.getPrototypeOf(uad) === NavigatorUAData.prototype));
    });
    try {
      const he = await uad.getHighEntropyValues(['platform', 'platformVersion', 'architecture', 'fullVersionList']);
      add('uad_high_entropy', (he.platform || '') + ' ' + (he.platformVersion || '') + ' ' + (he.architecture || ''), false);
    } catch (e) { add('uad_high_entropy', 'HIBA: ' + e.message, true); }
  }
  // sec-ch-ua fejléc ↔ userAgentData (csak ha a szerver kapott ilyet).
  safe('ch', () => {
    const h = H['sec-ch-ua'];
    const hp = (H['sec-ch-ua-platform'] || '').replace(/"/g, '');
    add('ch_header_platform_vs_ua', (hp || '(nincs)') + ' vs UA ' + uaOS, !!hp && hp !== uaOS);
    if (h && uad) {
      const hb = (h.match(/"([^"]+)";v="(\d+)"/g) || []).map(x => x.replace(/"/g, '').replace(';v=', '/')).sort().join(', ');
      const jb = (uad.brands || []).map(b => b.brand + '/' + b.version).sort().join(', ');
      add('ch_header_vs_uad', hb === jb ? 'egyezik' : 'fejléc: ' + hb + ' | JS: ' + jb, hb !== jb);
    }
  });

  // 5) Nyelvek: navigator.languages ↔ Accept-Language fejléc, language ↔ languages[0].
  safe('lang', () => {
    const nl = Array.from(navigator.languages || []);
    add('languages_nonempty', nl.join(','), nl.length === 0);
    add('language_vs_languages0', navigator.language + ' vs ' + nl[0], navigator.language !== nl[0]);
    const al = langsOf(H['accept-language']);
    // A Brave natívan REDUKÁL: navigator.languages = [első nyelv], a fejlécben
    // az első nyelv + alapnyelve marad. Nála csak az első nyelv egyezését nézzük.
    const isBrave = !!navigator.brave;
    const langBad = al.length > 0 && (isBrave ? nl[0] !== al[0] : nl.join(',') !== al.join(','));
    add('languages_vs_accept_language', nl.join(',') + ' vs fejléc ' + al.join(','), langBad);
    // Intl-locale ↔ navigator.language (alapnyelv szinten).
    const il = Intl.DateTimeFormat().resolvedOptions().locale;
    add('intl_locale_vs_language', il + ' vs ' + navigator.language, il.split('-')[0] !== String(navigator.language).split('-')[0]);
  });

  // 5b) Brave-azonosság ↔ UA-CH márka: navigator.brave mellett „Google Chrome"-ot állítani hazugság.
  safe('brave_brand', () => {
    const brands = (uad && uad.brands || []).map(b => b.brand);
    const isBrave = !!navigator.brave;
    add('brave_vs_brands', (isBrave ? 'navigator.brave VAN' : 'nincs navigator.brave') + ' / ' + (brands.join(', ') || '(üres)'),
      brands.length > 0 && isBrave !== brands.includes('Brave'));
  });

  // 5c) Alerőforrás-kérés fejlécei (fetch): a statikus, dokumentum-szintű
  // Accept / Upgrade-Insecure-Requests MINDEN kérésen árulkodó (a valódi Chrome
  // fetch-nél '*/*'-ot küld, UIR-t csak navigációnál).
  try {
    const eh = await (await fetch('/echo-headers', { cache: 'no-store' })).json();
    add('subresource_accept', eh.accept || '(nincs)', /text\/html/.test(eh.accept || ''));
    add('subresource_upgrade_insecure', eh['upgrade-insecure-requests'] || '(nincs)', !!eh['upgrade-insecure-requests']);
    add('subresource_ua_vs_js', eh['user-agent'] === ua ? 'egyezik' : 'ELTÉR: ' + eh['user-agent'], eh['user-agent'] !== ua);
  } catch (e) { add('subresource_accept', 'HIBA: ' + e.message, false); }

  // 6) plugins / mimeTypes.
  safe('plugins', () => {
    const p = navigator.plugins, m = navigator.mimeTypes;
    add('plugins_length', p.length, p.length === 0);
    add('plugins_type', p instanceof PluginArray, !(p instanceof PluginArray));
    add('mimetypes_length', m.length, m.length === 0);
    const names = Array.from(p).map(x => x.name);
    add('plugins_native_client', names.includes('Native Client'), names.includes('Native Client'));
    if (p.length) add('plugin_item_proto', p[0] instanceof Plugin, !(p[0] instanceof Plugin));
    if (m.length) add('mimetype_enabledPlugin', m[0].enabledPlugin instanceof Plugin, !(m[0].enabledPlugin instanceof Plugin));
  });

  // 7) permissions: a klasszikus headless-ellentmondás (Notification 'denied' + query 'prompt').
  try {
    const np = typeof Notification !== 'undefined' ? Notification.permission : '(nincs)';
    const st = (await navigator.permissions.query({ name: 'notifications' })).state;
    add('permissions_consistency', np + ' / ' + st, np === 'denied' && st === 'prompt');
  } catch (e) { add('permissions_consistency', 'HIBA: ' + e.message, true); }

  // 8) window.chrome és tagjai.
  safe('chrome', () => {
    const c = window.chrome;
    add('chrome_object', typeof c, !c);
    add('chrome_app', !!(c && 'app' in c), !(c && 'app' in c));
    add('chrome_csi', !!(c && typeof c.csi === 'function'), !(c && typeof c.csi === 'function'));
    add('chrome_loadTimes', !!(c && typeof c.loadTimes === 'function'), !(c && typeof c.loadTimes === 'function'));
    // A runtime jelenléte oldalfüggő (külső bővítmény nélkül általában nincs) — csak rögzítjük.
    add('chrome_runtime', c && c.runtime ? Object.keys(c.runtime).length + ' kulcs' : 'nincs', false);
  });

  // 9) srcdoc-iframe: contentWindow, self, [0]-szivárgás, srcdoc-getter rekurzió.
  safe('iframe', () => {
    const f = document.createElement('iframe');
    f.srcdoc = '<p>x</p>';
    document.body.appendChild(f);
    const w = f.contentWindow;
    add('iframe_contentWindow', !!w, !w);
    if (w) {
      add('iframe_self_not_top', w.self !== window, w.self === window);
      add('iframe_index0_leak', w[0] !== undefined, w[0] !== undefined);
      add('iframe_chrome', !!w.chrome, !w.chrome);
    }
    let rec = false;
    try { void f.srcdoc; } catch (e) { rec = true; }
    add('iframe_srcdoc_recursion', rec, rec);
    f.remove();
  });

  // 10) WebGL vendor/renderer.
  safe('webgl', () => {
    const cv = document.createElement('canvas');
    const gl = cv.getContext('webgl') || cv.getContext('experimental-webgl');
    if (!gl) { add('webgl_available', false, true); return; }
    add('webgl_available', true, false);
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const ven = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : '(nincs ext)';
    const ren = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '(nincs ext)';
    add('webgl_vendor', ven, false);
    add('webgl_renderer_software', ren, /SwiftShader|llvmpipe|softpipe/i.test(ren));
    // Mac-only renderer-sztring („… OpenGL Engine", „Apple") nem-mac UA mellett ellentmondás.
    const macish = /OpenGL Engine|Apple (M\d|GPU)/.test(ren);
    add('webgl_renderer_vs_ua_os', ren + ' / UA:' + uaOS, (macish && uaOS !== 'macOS') || (/Direct3D/.test(ren) && uaOS !== 'Windows'));
  });

  // 11) Külső ablakméret (régi headless: 0).
  add('outer_dimensions', outerWidth + 'x' + outerHeight, outerWidth === 0 || outerHeight === 0);

  // 12) Hamisított getterek natívnak látszanak-e (toString + Illegal invocation).
  safe('tostring', () => {
    const bad = [];
    for (const k of ['languages', 'vendor', 'hardwareConcurrency', 'platform', 'userAgent', 'plugins', 'mimeTypes', 'deviceMemory']) {
      const d = Object.getOwnPropertyDescriptor(Navigator.prototype, k);
      if (!d || !d.get) continue;
      if (!isNative(d.get)) bad.push(k + ':toString');
      let threw = false;
      try { d.get.call({}); } catch (e) { threw = true; }
      if (!threw) bad.push(k + ':noIllegalInvocation');
    }
    if (navigator.permissions && !isNative(navigator.permissions.query)) bad.push('permissions.query');
    add('getters_look_native', bad.length ? bad.join(',') : 'mind natív', bad.length > 0);
  });

  // 13) hardver.
  add('hardwareConcurrency', navigator.hardwareConcurrency, !navigator.hardwareConcurrency);
  add('deviceMemory', String(navigator.deviceMemory), false);

  // 14) Globális szivárgás (deklaráció nélküli stealth-változók).
  safe('globals', () => {
    const leaks = ['data', 'generateFunctionMocks', 'utils', 'opts', 'STATIC_DATA'].filter(k => k in window);
    add('global_leaks', leaks.join(',') || 'nincs', leaks.length > 0);
  });

  // 15) Média-kodek (Chromium H.264 nélkül).
  safe('codec', () => {
    const r = document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"');
    add('codec_h264', r || '(üres)', r === '');
  });

  // 16) Worker-kontextus ↔ főszál (UA, platform, nyelvek, UA-CH).
  try {
    const src = 'let gr="";try{const g=new OffscreenCanvas(8,8).getContext("webgl");const x=g&&g.getExtension("WEBGL_debug_renderer_info");gr=x?g.getParameter(x.UNMASKED_RENDERER_WEBGL):"";}catch(e){}' +
      'postMessage({gr,ua:navigator.userAgent,pl:navigator.platform,lang:Array.from(navigator.languages||[]).join(","),hc:navigator.hardwareConcurrency,' +
      'br:(navigator.userAgentData&&navigator.userAgentData.brands||[]).map(b=>b.brand+"/"+b.version).join(", "),' +
      'up:navigator.userAgentData?navigator.userAgentData.platform:""})';
    const wk = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    const w = await new Promise((res, rej) => { wk.onmessage = (e) => res(e.data); wk.onerror = (e) => rej(e); setTimeout(() => rej(new Error('worker timeout')), 3000); });
    wk.terminate();
    const mainBr = (uad && uad.brands || []).map(b => b.brand + '/' + b.version).join(', ');
    add('worker_ua_vs_main', w.ua === ua ? 'egyezik' : 'WORKER: ' + w.ua, w.ua !== ua);
    add('worker_platform_vs_main', w.pl + ' vs ' + navigator.platform, w.pl !== navigator.platform);
    add('worker_languages_vs_main', w.lang + ' vs ' + Array.from(navigator.languages).join(','), w.lang !== Array.from(navigator.languages).join(','));
    add('worker_hardwareConcurrency_vs_main', w.hc + ' vs ' + navigator.hardwareConcurrency, w.hc !== navigator.hardwareConcurrency);
    // Worker-WebGL (OffscreenCanvas): a lapra tett getParameter-proxy ide nem ér el.
    let mainRen = '';
    try { const g = document.createElement('canvas').getContext('webgl'); const x = g && g.getExtension('WEBGL_debug_renderer_info'); mainRen = x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : ''; } catch (e) {}
    if (w.gr && mainRen) add('worker_webgl_vs_main', w.gr === mainRen ? 'egyezik' : 'WORKER: ' + w.gr, w.gr !== mainRen);
    add('worker_uad_vs_main', w.br === mainBr && w.up === (uad ? uad.platform : '') ? 'egyezik' : 'WORKER: ' + w.br + ' ' + w.up, !(w.br === mainBr && w.up === (uad ? uad.platform : '')));
  } catch (e) { add('worker_ua_vs_main', 'HIBA: ' + (e && e.message), false); }

  // 17) Canvas (W2, 2026-10-07): stabil-e egy lapon belül, és a worker
  // (OffscreenCanvas) ugyanazt rajzolja-e, mint a fő szál — egy JS-szintű
  // canvas-zaj a workerbe nem ér el (ellentmondás = jel). A hash maga csak
  // tájékoztató (Brave alatt a farbling munkamenetenként más).
  try {
    const DRAW = 'function draw(c){const x=c.getContext("2d");x.fillStyle="#f60";x.fillRect(10,10,100,40);x.fillStyle="#069";' +
      'x.font="16px Arial";x.fillText("Cwm fjordbank glyphs vext quiz",4,30);x.strokeStyle="rgba(102,204,0,0.7)";' +
      'x.beginPath();x.arc(80,30,22,0,Math.PI*2);x.stroke();return x.getImageData(0,0,c.width,c.height).data;}' +
      'function fnv(d){let h=2166136261;for(let i=0;i<d.length;i++){h^=d[i];h=Math.imul(h,16777619)>>>0;}return h.toString(16);}';
    const mainHash = new Function(DRAW + 'return (c)=>fnv(draw(c));')();
    const c1 = document.createElement('canvas'); c1.width = 220; c1.height = 60;
    const c2 = document.createElement('canvas'); c2.width = 220; c2.height = 60;
    const h1 = mainHash(c1), h2 = mainHash(c2);
    add('canvas_stable', h1 === h2 ? 'stabil' : 'ELTÉR: ' + h1 + ' vs ' + h2, h1 !== h2);
    add('canvas_hash', h1, false);
    const wsrc = DRAW + 'const o=new OffscreenCanvas(220,60);postMessage(fnv(draw(o)));';
    const wk = new Worker(URL.createObjectURL(new Blob([wsrc], { type: 'text/javascript' })));
    const wh = await new Promise((res, rej) => { wk.onmessage = (e) => res(e.data); wk.onerror = (e) => rej(e); setTimeout(() => rej(new Error('worker timeout')), 3000); });
    wk.terminate();
    add('canvas_worker_vs_main', wh === h1 ? 'egyezik' : 'WORKER: ' + wh + ' vs ' + h1, wh !== h1);
  } catch (e) { add('canvas_worker_vs_main', 'HIBA: ' + (e && e.message), false); }

  // 18) WebRTC (W2): a helyi (nem mDNS-elrejtett) IP kiszivárog-e az ICE-
  // jelöltekben. STUN nélkül (hálózat nem kell): csak a host-jelöltek.
  try {
    const pc = new RTCPeerConnection({ iceServers: [] });
    const cands = [];
    pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) cands.push(e.candidate.candidate); };
    pc.createDataChannel('x');
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise(r => setTimeout(r, 1200));
    pc.close();
    const ips = cands.map(c => (c.split(' ')[4] || '')).filter(Boolean);
    const raw = ips.filter(ip => !/\.local$/i.test(ip));
    add('webrtc_candidates', ips.length + (raw.length ? ' (nyers: ' + raw.join(',') + ')' : ''), false);
    add('webrtc_local_ip_leak', raw.length ? raw.join(',') : 'nincs', raw.length > 0);
  } catch (e) { add('webrtc_local_ip_leak', 'HIBA: ' + (e && e.message), false); }

  const bots = Object.keys(R).filter(k => R[k].bot);
  const out = { signals: bots.length, checks: Object.keys(R).length, bots, results: R };
  const pre = document.getElementById('out');
  // A jelölők a forrásban DARABOLVA (a body-szövegben a script forrása is benne van).
  pre.textContent = 'PROBE_JSON_' + 'BEGIN' + JSON.stringify(out) + 'PROBE_JSON_' + 'END';
  document.title = 'probe-done';
})();
`;

// A fixtúra-szerver útvonalai (a test/helpers.js startFixture()-éhez).
export function probeRoutes() {
  const page = (req, res) => {
    const H = {};
    for (const k of ['user-agent', 'accept-language', 'sec-ch-ua', 'sec-ch-ua-platform', 'sec-ch-ua-mobile']) {
      if (req.headers[k] !== undefined) H[k] = req.headers[k];
    }
    // </script>-injekció ellen a JSON-ban a '<' kódolva.
    const hj = JSON.stringify(H).replace(/</g, '\\u003c');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>probe</title></head>
<body><h1>stealth probe</h1><pre id="out">PROBE_PENDING</pre>
<script>window.__PROBE_HEADERS__ = ${hj};</script>
<script>${PROBE_SCRIPT}</script></body></html>`);
  };
  // A lap fetch-kérésének fejlécei visszatükrözve (alerőforrás-fejléc mérés).
  const echo = (req, res) => {
    const out = {};
    for (const k of ['accept', 'upgrade-insecure-requests', 'user-agent', 'accept-language', 'sec-fetch-dest']) {
      if (req.headers[k] !== undefined) out[k] = req.headers[k];
    }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(out));
  };
  return { '/probe': page, '/echo-headers': echo };
}

// A scrape-eredmény szövegéből kiveszi a detektor JSON-ját (vagy null).
export function parseProbe(text) {
  const m = String(text || '').match(/PROBE_JSON_BEGIN([\s\S]*?)PROBE_JSON_END/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (_) { return null; }
}
