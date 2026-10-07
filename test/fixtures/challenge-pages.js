// Szimulált anti-bot challenge-lapok (W2, 2026-10-07) a test/helpers.js
// startFixture()-éhez. A jelölők a valódi lapok jelölőit utánozzák (a
// challenge.js felismerője ugyanazt látja), a viselkedés:
//   /cf?d=<ms>   Cloudflare „Just a moment…" (non-interactive): d ms után a lap
//                JS-e sütit ír (cf_clearance=cf-ok) és újratölt → cikk.
//   /cf-never    ugyanez, de sosem enged tovább.
//   /ts          Cloudflare managed challenge Turnstile-iframe-mel: a checkboxra
//                VALÓDI kattintás kell (isTrusted) → süti (cf_clearance=ts-ok) +
//                újratöltés → cikk, benne a kattintás mérése (trusted, egér-
//                mozgások száma a fő lapon és a kereten, gombnyomás-idő).
//   /cdn-cgi/challenge-platform/…/turnstile/…  a Turnstile-iframe tartalma.
//   /dd?d=<ms>   DataDome interstitial ('rt':'i') → süti (datadome=…) + újratöltés.
//   /px          PerimeterX „Press & Hold" (sosem enged tovább).
//   /cf-block    Cloudflare 1020 („Sorry, you have been blocked") — végleges fal.
//   /normal      normál lap a CF jsd-szkriptjével és „Ray ID"-vel — NEM challenge.
//   /human       emberi-bemenet mérő (egér- és billentyű-események idő- és
//                trusted-naplója a window.__ev-ben).

const ARTICLE = (title, extra = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><article><h1>${title}</h1>
<p>ARTICLE-CONTENT-OK. ${extra}</p>
${Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i + 1}: the quick brown fox jumps over the lazy dog while the committee publishes its quarterly report on regional infrastructure, budgets and public transport reliability.</p>`).join('\n')}
</article></body></html>`;

const cookiesOf = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';')
  .map(s => s.trim()).filter(Boolean).map(s => { const i = s.indexOf('='); return [s.slice(0, i), decodeURIComponent(s.slice(i + 1))]; }));

const html = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

const CF_INTERSTITIAL = ({ ctype = 'non-interactive', script = '', body = '' }) => `<!DOCTYPE html><html lang="en-US"><head>
<title>Just a moment...</title><meta http-equiv="content-type" content="text/html; charset=UTF-8">
<meta name="robots" content="noindex,nofollow"></head><body>
<div class="main-wrapper" role="main"><div class="main-content">
<h1 class="zone-name-title h1">127.0.0.1</h1>
<p id="challenge-body-text">Verifying you are human. This may take a few seconds.</p>
${body}
<div id="challenge-running">Checking your browser before accessing 127.0.0.1.</div>
</div></div>
<script>(function(){window._cf_chl_opt={cvId: '3',cZone: '127.0.0.1',cType: '${ctype}',cRay: 'fx${Date.now().toString(16)}'};
${script}})();</script></body></html>`;

export function challengeRoutes() {
  return {
    '/cf': (req, res, u) => {
      if (cookiesOf(req).cf_clearance === 'cf-ok') return html(res, ARTICLE('Interstitial passed'));
      const d = Math.max(0, Math.min(20000, parseInt(u.searchParams.get('d') || '2500', 10) || 0));
      return html(res, CF_INTERSTITIAL({ script: `setTimeout(function(){document.cookie='cf_clearance=cf-ok; path=/';location.reload();}, ${d});` }), 403);
    },
    '/cf-never': (req, res) => html(res, CF_INTERSTITIAL({}), 403),
    // ?show=<ms>: a widget előbb „Verifying…" (checkbox NÉLKÜL), a checkbox csak
    // ennyi után jelenik meg — mint a valódi Turnstile, ha a nem-interaktív próba elbukik.
    '/ts': (req, res, u) => {
      const c = cookiesOf(req);
      if (c.cf_clearance === 'ts-ok') return html(res, ARTICLE('Turnstile passed', `TS_INFO ${c.ts_info || ''}`));
      const show = Math.max(0, Math.min(20000, parseInt(u.searchParams.get('show') || '0', 10) || 0));
      const frame = '/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/0x4AAAAAAAFixtureSiteKey00/light/fbE/new/normal/auto/' + (show ? `?show=${show}` : '');
      return html(res, CF_INTERSTITIAL({
        ctype: 'managed',
        body: `<div><div><div id="ts-holder"><iframe src="${frame}" title="Widget containing a Cloudflare security challenge"
          style="width:300px;height:65px;border:0;display:block"></iframe></div></div></div>`,
        script: `window.__mainMoves=0;document.addEventListener('mousemove',function(e){if(e.isTrusted)window.__mainMoves++;});
          window.addEventListener('message',function(e){var m=e.data||{};if(!m||m.kind!=='ts')return;
            document.cookie='ts_info='+encodeURIComponent('trusted='+m.trusted+' main_moves='+window.__mainMoves+' frame_moves='+m.frameMoves+' press_ms='+m.pressMs+' early_clicks='+m.early)+'; path=/';
            if(m.trusted){document.cookie='cf_clearance=ts-ok; path=/';setTimeout(function(){location.reload();},300);}});`,
      }), 403);
    },
    '/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/0x4AAAAAAAFixtureSiteKey00/light/fbE/new/normal/auto/': (req, res) => html(res,
      `<!doctype html><html><head><style>body{margin:0;background:#fafafa;font:14px sans-serif}
        #cb{position:absolute;left:16px;top:16px;width:24px;height:24px;margin:0}
        label{position:absolute;left:52px;top:19px}</style></head><body>
        <div id="spin">Verifying...</div>
        <script>var moves=0,down=0,early=0;document.addEventListener('mousemove',function(e){if(e.isTrusted)moves++;});
          document.addEventListener('mousedown',function(e){if(!document.getElementById('cb'))early++;});
          var show=parseInt(new URLSearchParams(location.search).get('show')||'0',10);
          setTimeout(function(){document.getElementById('spin').remove();
            document.body.insertAdjacentHTML('beforeend','<input type="checkbox" id="cb"><label for="cb">Verify you are human</label>');
            var cb=document.getElementById('cb');
            cb.addEventListener('mousedown',function(){down=performance.now();});
            cb.addEventListener('click',function(e){parent.postMessage({kind:'ts',trusted:e.isTrusted,frameMoves:moves,early:early,
              pressMs:down?Math.round(performance.now()-down):-1},'*');});}, show);</script></body></html>`),
    '/dd': (req, res, u) => {
      if (cookiesOf(req).datadome === 'dd-ok') return html(res, ARTICLE('DataDome passed'));
      const d = Math.max(0, Math.min(20000, parseInt(u.searchParams.get('d') || '1500', 10) || 0));
      return html(res, `<html><head><title>127.0.0.1</title><style>#cmsg{animation: A 1.5s;}</style></head>
        <body style="margin:0"><p id="cmsg">Please enable JS and disable any ad blocker</p>
        <script data-cfasync="false">var dd={'rt':'i','cid':'AHrlqAAAAAMAfixture','hsh':'FIXTURE','t':'fe','s':1234,'e':'x','host':'geo.captcha-delivery.com'}</script>
        <script>setTimeout(function(){document.cookie='datadome=dd-ok; path=/';location.reload();}, ${d});</script>
        <!-- <script src="https://ct.captcha-delivery.com/i.js"></script> -->
        </body></html>`, 403);
    },
    '/px': (req, res) => html(res, `<!DOCTYPE html><html lang="en"><head><title>Access to this page has been denied</title></head>
      <body><div class="px-captcha-container"><p>Press &amp; Hold to confirm you are a human (and not a bot).</p>
      <div id="px-captcha"></div></div><script>window._pxAppId='PXfixture';window._pxJsClientSrc='/fixture/init.js';</script></body></html>`, 403),
    '/cf-block': (req, res) => html(res, `<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head>
      <body><div id="cf-wrapper"><div id="cf-error-details" class="cf-error-details-wrapper">
      <h1 data-translate="block_headline">Sorry, you have been blocked</h1><h2>You are unable to access 127.0.0.1</h2>
      <span class="cf-error-code">1020</span></div></div></body></html>`, 403),
    // Turnstile-KAPU (beágyazott widget, rövid lap): a widget data-callback-je a
    // tokennel sütit ír + újratölt — a megoldó-horog (token-befecskendezés) mérője.
    '/gate': (req, res) => {
      const c = cookiesOf(req);
      if (c.cf_clearance === 'gate-ok') return html(res, ARTICLE('Gate passed', `GATE_TOKEN ${c.gate_tok || ''}`));
      return html(res, `<!doctype html><html><head><title>Verify</title></head><body>
        <form method="post"><p>Please verify you are human to continue.</p>
        <div class="cf-turnstile" data-sitekey="0x4AAAAAAAGateFixtureKey0" data-callback="onTs"></div>
        <input type="hidden" name="cf-turnstile-response" value=""></form>
        <script>function onTs(tok){document.cookie='gate_tok='+encodeURIComponent(tok)+'; path=/';
          document.cookie='cf_clearance=gate-ok; path=/';setTimeout(function(){location.reload();},200);}</script>
        </body></html>`, 403);
    },
    '/normal': (req, res) => html(res, ARTICLE('Normal CF-fronted page',
      'Cloudflare Ray ID: 8a1b2c3d4e5f · Performance &amp; security by Cloudflare') +
      `<script>(function(){var js = document.createElement('script');js.src = '/cdn-cgi/challenge-platform/scripts/jsd/main.js';})();</script>`),
    '/human': `<!doctype html><html><head><title>Human input</title>
      <style>body{margin:0;height:900px} #btn{position:absolute;left:700px;top:500px;width:140px;height:40px}
      #inp{position:absolute;left:100px;top:100px;width:300px}</style></head><body>
      <input id="inp"><button id="btn" onclick="document.title='clicked'">Go</button>
      <script>window.__ev=[];const L=(e)=>__ev.push({t:e.type,ts:Math.round(e.timeStamp*10)/10,tr:e.isTrusted,k:e.key||'',x:e.clientX||0,y:e.clientY||0});
        for (const t of ['mousemove','mousedown','mouseup','click','keydown','keyup']) document.addEventListener(t, L, true);</script></body></html>`,
  };
}
