// VENDOROLT, SZÓ SZERINTI MÁSOLAT — ne szerkeszd (a módosítás a wrapperben él: ../page-script.js).
// Forrás: https://github.com/tinyfish-io/tf-playwright-stealth @ b1206e7ed847bf02d3aa895c3e09da02db4fd3bd
//         playwright_stealth/js/webgl.vendor.js
// Licenc: MIT — Copyright (c) 2020 ASAS1314 (a teljes szöveg: /THIRD_PARTY_NOTICES.md).
// Eredet:  berstend/puppeteer-extra — puppeteer-extra-plugin-stealth (MIT, Copyright (c) 2019 berstend).
// Az alábbi sorok bájtra azonosak a forrással (sha256 a THIRD_PARTY_NOTICES.md-ben).

const getParameterProxyHandler = {
  apply: function (target, ctx, args) {
    const param = (args || [])[0];
    const result = utils.cache.Reflect.apply(target, ctx, args);
    // UNMASKED_VENDOR_WEBGL
    if (param === 37445) {
      return opts.webgl.vendor || "Intel Inc."; // default in headless: Google Inc.
    }
    // UNMASKED_RENDERER_WEBGL
    if (param === 37446) {
      return opts.webgl.renderer || "Intel Iris OpenGL Engine"; // default in headless: Google SwiftShader
    }
    return result;
  },
};

// There's more than one WebGL rendering context
// https://developer.mozilla.org/en-US/docs/Web/API/WebGL2RenderingContext#Browser_compatibility
// To find out the original values here: Object.getOwnPropertyDescriptors(WebGLRenderingContext.prototype.getParameter)
const addProxy = (obj, propName) => {
  utils.replaceWithProxy(obj, propName, getParameterProxyHandler);
};
// For whatever weird reason loops don't play nice with Object.defineProperty, here's the next best thing:
addProxy(WebGLRenderingContext.prototype, "getParameter");
addProxy(WebGL2RenderingContext.prototype, "getParameter");
