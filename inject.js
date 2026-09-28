"use strict";

// Código executado no contexto da PÁGINA (não no mundo isolado da extensão),
// para interceptar as APIs que os scripts do site realmente chamam.
//
// Este arquivo é carregado como content script antes do content.js apenas para
// definir a função; o content.js a injeta na página como <script> inline, que
// executa de forma síncrona, antes dos scripts do site. Se a CSP da página
// bloquear o inline, o content.js injeta este arquivo via <script src> e o
// trecho no final do arquivo dispara a função.
function privacyGuardPageHook(token) {
  // Marca a instalação para o content.js confirmar que o inline não foi bloqueado
  document.documentElement.setAttribute("data-privacy-guard", token);

  // Referências guardadas antes dos scripts da página: um script que sobrescreva
  // window.postMessage ou Function.prototype.toString não afeta a extensão
  const nativePostMessage = window.postMessage.bind(window);
  const nativeToString = Function.prototype.toString;

  function post(data) {
    data.__privacyGuard = token;
    nativePostMessage(data, "*");
  }

  // URL do script que chamou a API: pula os frames do próprio hook na pilha
  // (callerScript + hook = 2; hooks que passam por uma função auxiliar pulam 3)
  function callerScript(skip = 2) {
    const lines = (new Error().stack || "").split("\n").slice(skip);
    for (const line of lines) {
      const m = line.match(/(https?:\/\/[^\s)]+?):\d+:\d+/);
      if (m) return m[1];
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Instalação dos hooks por janela
  // -------------------------------------------------------------------------
  // Cada janela (a página e cada iframe) tem seus próprios protótipos: um hook
  // em HTMLCanvasElement.prototype da página não vale para um canvas criado com
  // iframe.contentDocument.createElement("canvas"). Scripts de fingerprint usam
  // isso para escapar de extensões, então os hooks são instalados também nas
  // janelas de iframes assim que a página acessa contentWindow/contentDocument.
  const hookedWindows = new WeakSet();

  function installHooks(win) {
    if (hookedWindows.has(win)) return;
    hookedWindows.add(win);
    try {
      installStorageHooks(win);
      installCanvasHooks(win);
      installFrameHooks(win);
    } catch (e) {
      // janela de outra origem: sem acesso aos protótipos (o content script
      // do próprio iframe cobre esse caso)
    }
  }

  function installFrameHooks(win) {
    for (const Frame of [win.HTMLIFrameElement, win.HTMLFrameElement]) {
      if (!Frame) continue;
      for (const prop of ["contentWindow", "contentDocument"]) {
        const desc = Object.getOwnPropertyDescriptor(Frame.prototype, prop);
        if (!desc || !desc.get) continue;
        Object.defineProperty(Frame.prototype, prop, Object.assign({}, desc, {
          get() {
            const result = desc.get.call(this);
            try {
              const child = prop === "contentWindow" ? result : result && result.defaultView;
              if (child) installHooks(child);
            } catch (e) {}
            return result;
          }
        }));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Web Storage (localStorage / sessionStorage) e IndexedDB
  // -------------------------------------------------------------------------
  function installStorageHooks(win) {
    function storageName(storage) {
      try {
        if (storage === win.localStorage) return "localStorage";
        if (storage === win.sessionStorage) return "sessionStorage";
      } catch (e) {
        // acesso ao storage bloqueado (ex.: iframe de 3ª parte sem permissão)
      }
      return "storage";
    }

    const origSetItem = win.Storage.prototype.setItem;
    win.Storage.prototype.setItem = function (key, value) {
      try {
        post({
          kind: "storage",
          api: storageName(this),
          op: "setItem",
          key: String(key),
          size: String(value).length,
          // Valor (truncado) só para o background comparar com parâmetros de URL
          value: String(value).slice(0, 256),
          script: callerScript()
        });
      } catch (e) {}
      return origSetItem.apply(this, arguments);
    };

    const origOpen = win.IDBFactory.prototype.open;
    win.IDBFactory.prototype.open = function (name) {
      try {
        post({
          kind: "storage",
          api: "indexedDB",
          op: "open",
          key: String(name),
          script: callerScript()
        });
      } catch (e) {}
      return origOpen.apply(this, arguments);
    };
  }

  // -------------------------------------------------------------------------
  // Retrato do armazenamento: pega também gravações que não passam por
  // setItem (ex.: localStorage.chave = valor) e dados de visitas anteriores
  // -------------------------------------------------------------------------
  function keysOf(name) {
    try {
      return Object.keys(window[name]);
    } catch (e) {
      return null; // null = acesso bloqueado
    }
  }

  async function snapshot() {
    const data = {
      kind: "snapshot",
      localStorage: keysOf("localStorage"),
      sessionStorage: keysOf("sessionStorage"),
      indexedDB: null
    };
    try {
      if (indexedDB.databases) {
        data.indexedDB = (await indexedDB.databases()).map((db) => db.name);
      }
    } catch (e) {}
    post(data);
  }

  window.addEventListener("load", () => {
    snapshot();
    setTimeout(snapshot, 3000); // scripts de rastreamento costumam gravar após o load
  });

  // -------------------------------------------------------------------------
  // Canvas fingerprint
  // -------------------------------------------------------------------------
  // Critérios de Englehardt & Narayanan (2016, "Online Tracking: A 1-million-site
  // Measurement and Analysis"): canvas >= 16x16, texto com >= 10 caracteres
  // distintos ou >= 2 cores, extração da imagem em formato sem perda.
  //
  // Estado por canvas (HTMLCanvasElement ou OffscreenCanvas): o que foi desenhado
  const canvasState = new WeakMap();
  const bitmapState = new WeakMap(); // ImageBitmap -> estado do canvas de origem

  function stateOf(canvas) {
    let s = canvasState.get(canvas);
    if (!s) {
      s = { chars: new Set(), colors: new Set(), webgl: false };
      canvasState.set(canvas, s);
    }
    return s;
  }

  function mergeState(target, source) {
    if (!source) return;
    for (const c of source.chars) target.chars.add(c);
    for (const c of source.colors) target.colors.add(c);
  }

  function reportExtraction(canvas, method, width, height, format) {
    const s = stateOf(canvas);
    // Cada canvas é reportado uma vez por método: getImageData pode ser
    // chamado a cada quadro em jogos/animações usando o mesmo canvas
    s.reported = s.reported || new Set();
    if (s.reported.has(method)) return;
    s.reported.add(method);

    const big = width >= 16 && height >= 16;
    const richText = s.chars.size >= 10 || s.colors.size >= 2;
    const lossy = /jpe?g|webp/i.test(format || "");
    const fingerprint = big && (s.webgl || (richText && !lossy));
    const script = callerScript(3); // callerScript + reportExtraction + hook

    post({
      kind: "canvas",
      method,
      width,
      height,
      format: format || "image/png",
      chars: s.chars.size,
      colors: s.colors.size,
      webgl: s.webgl,
      fingerprint,
      script
    });
  }

  function installCanvasHooks(win) {
    // Desenho de texto: registra caracteres e cor usada
    function hookText(proto) {
      for (const name of ["fillText", "strokeText"]) {
        const orig = proto[name];
        proto[name] = function (text) {
          try {
            const s = stateOf(this.canvas);
            for (const c of Array.from(String(text))) s.chars.add(c);
            s.colors.add(String(name === "fillText" ? this.fillStyle : this.strokeStyle));
          } catch (e) {}
          return orig.apply(this, arguments);
        };
      }
    }

    // Copiar um canvas/bitmap para outro leva junto o que foi desenhado
    // (a página do DDG desenha num OffscreenCanvas e extrai de um canvas comum)
    function hookDrawImage(proto) {
      const orig = proto.drawImage;
      proto.drawImage = function (source) {
        try {
          mergeState(stateOf(this.canvas), canvasState.get(source) || bitmapState.get(source));
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    }

    function hookGetImageData(proto) {
      const orig = proto.getImageData;
      proto.getImageData = function (sx, sy, sw, sh) {
        try {
          reportExtraction(this.canvas, "getImageData", Math.abs(sw), Math.abs(sh), null);
        } catch (e) {}
        return orig.apply(this, arguments);
      };
    }

    for (const Ctx of [win.CanvasRenderingContext2D, win.OffscreenCanvasRenderingContext2D]) {
      if (!Ctx) continue;
      hookText(Ctx.prototype);
      hookDrawImage(Ctx.prototype);
      hookGetImageData(Ctx.prototype);
    }

    // Contexto WebGL: renderização depende de GPU/driver, também serve de fingerprint
    const origGetContext = win.HTMLCanvasElement.prototype.getContext;
    win.HTMLCanvasElement.prototype.getContext = function (type) {
      try {
        if (/webgl/i.test(String(type))) stateOf(this).webgl = true;
      } catch (e) {}
      return origGetContext.apply(this, arguments);
    };

    const origToDataURL = win.HTMLCanvasElement.prototype.toDataURL;
    win.HTMLCanvasElement.prototype.toDataURL = function (type) {
      try {
        reportExtraction(this, "toDataURL", this.width, this.height, type);
      } catch (e) {}
      return origToDataURL.apply(this, arguments);
    };

    const origToBlob = win.HTMLCanvasElement.prototype.toBlob;
    win.HTMLCanvasElement.prototype.toBlob = function (callback, type) {
      try {
        reportExtraction(this, "toBlob", this.width, this.height, type);
      } catch (e) {}
      return origToBlob.apply(this, arguments);
    };

    for (const GL of [win.WebGLRenderingContext, win.WebGL2RenderingContext]) {
      if (!GL) continue;
      const origReadPixels = GL.prototype.readPixels;
      GL.prototype.readPixels = function (x, y, width, height) {
        try {
          stateOf(this.canvas).webgl = true;
          reportExtraction(this.canvas, "readPixels", width, height, null);
        } catch (e) {}
        return origReadPixels.apply(this, arguments);
      };
    }

    if (win.OffscreenCanvas) {
      const origTransfer = win.OffscreenCanvas.prototype.transferToImageBitmap;
      win.OffscreenCanvas.prototype.transferToImageBitmap = function () {
        const bitmap = origTransfer.apply(this, arguments);
        try {
          bitmapState.set(bitmap, stateOf(this));
        } catch (e) {}
        return bitmap;
      };

      const origConvert = win.OffscreenCanvas.prototype.convertToBlob;
      if (origConvert) {
        win.OffscreenCanvas.prototype.convertToBlob = function (options) {
          try {
            reportExtraction(this, "convertToBlob", this.width, this.height, options && options.type);
          } catch (e) {}
          return origConvert.apply(this, arguments);
        };
      }
    }
  }

  installHooks(window);

  // -------------------------------------------------------------------------
  // Hijacking / hook: globais adicionadas e funções nativas sobrescritas
  // -------------------------------------------------------------------------
  // Só no documento principal. O retrato inicial é tirado aqui, em
  // document_start, depois dos hooks da própria extensão e antes de qualquer
  // script da página.
  if (window !== window.top) return;

  // Funções usadas para interceptar tráfego, eventos e DOM. Um script que as
  // substitui consegue ler ou alterar tudo que a página envia e recebe.
  const CRITICAL_NATIVES = [
    ["window", "fetch"], ["window", "XMLHttpRequest"], ["window", "WebSocket"],
    ["window", "EventSource"], ["window", "open"], ["window", "eval"],
    ["window", "setTimeout"], ["window", "setInterval"], ["window", "postMessage"],
    ["XMLHttpRequest.prototype", "open"], ["XMLHttpRequest.prototype", "send"],
    ["XMLHttpRequest.prototype", "setRequestHeader"],
    ["Navigator.prototype", "sendBeacon"],
    ["EventTarget.prototype", "addEventListener"],
    ["Document.prototype", "write"], ["Document.prototype", "createElement"],
    ["Node.prototype", "appendChild"], ["Node.prototype", "insertBefore"],
    ["History.prototype", "pushState"], ["History.prototype", "replaceState"],
    ["Function.prototype", "toString"], ["JSON", "stringify"], ["JSON", "parse"]
  ];

  // Globais de bibliotecas de rastreamento/hook conhecidas
  const KNOWN_GLOBALS = {
    beef: "BeEF (Browser Exploitation Framework)",
    BeefJS: "BeEF (Browser Exploitation Framework)",
    beef_init: "BeEF (Browser Exploitation Framework)",
    dataLayer: "Google Tag Manager",
    google_tag_manager: "Google Tag Manager",
    gtag: "Google Analytics (gtag.js)",
    ga: "Google Analytics (analytics.js)",
    googletag: "Google Publisher Tag (anúncios)",
    fbq: "Meta Pixel",
    _fbq: "Meta Pixel",
    ttq: "TikTok Pixel",
    _hsq: "HubSpot",
    hj: "Hotjar (session replay)",
    clarity: "Microsoft Clarity (session replay)",
    FS: "FullStory (session replay)",
    _satellite: "Adobe Experience Platform",
    pbjs: "Prebid.js (header bidding)",
    apstag: "Amazon Publisher Services",
    Criteo: "Criteo",
    uetq: "Microsoft Advertising (UET)",
    _linkedin_partner_id: "LinkedIn Insight Tag",
    ym: "Yandex Metrica",
    _paq: "Matomo",
    mixpanel: "Mixpanel",
    amplitude: "Amplitude",
    OneSignal: "OneSignal (push)",
    _gaq: "Google Analytics (ga.js, legado)",
    gptadslots: "Google Publisher Tag (anúncios)",
    adsbygoogle: "Google AdSense",
    utag: "Tealium iQ (tag manager)",
    utag_data: "Tealium iQ (tag manager)",
    _comscore: "comScore",
    COMSCORE: "comScore",
    permutive: "Permutive (segmentação de audiência)",
    __tcfapi: "CMP / IAB TCF (consentimento)",
    OneTrust: "OneTrust (consentimento)",
    __SENTRY__: "Sentry (monitoramento de erros)",
    NREUM: "New Relic (monitoramento)",
    newrelic: "New Relic (monitoramento)"
  };

  // Marcas que bibliotecas conhecidas deixam na função que substituem
  // (referência para a original): permitem apontar o provável autor
  const WRAPPER_MARKERS = {
    __sentry_original__: "Sentry",
    __zone_symbol__OriginalDelegate: "zone.js (Angular)",
    __rrweb_original__: "rrweb (session replay)"
  };

  function wrapperAuthor(fn) {
    for (const [marker, name] of Object.entries(WRAPPER_MARKERS)) {
      try {
        if (fn && fn[marker]) return name;
      } catch (e) {}
    }
    return null;
  }
  const BEEF_GLOBALS = ["beef", "BeefJS", "beef_init"];

  function resolvePath(path) {
    return path.split(".").reduce((obj, key) => (key === "window" ? window : obj[key]), window);
  }

  const nativeRefs = new Map();
  for (const [path, prop] of CRITICAL_NATIVES) {
    try {
      nativeRefs.set(`${path}.${prop}`.replace(/^window\./, ""), [path, prop, resolvePath(path)[prop]]);
    } catch (e) {}
  }

  const baselineGlobals = new Set(Object.getOwnPropertyNames(window));

  // Funções nativas que aparecem depois (APIs resolvidas sob demanda pelo
  // navegador) não são adições da página
  function isNativeFunction(value) {
    try {
      return typeof value === "function" && /\[native code\]\s*\}$/.test(nativeToString.call(value));
    } catch (e) {
      return false;
    }
  }

  function checkGlobals() {
    const added = [];
    for (const name of Object.getOwnPropertyNames(window)) {
      if (baselineGlobals.has(name) || name === "privacyGuardPageHook") continue;
      if (/^\d+$/.test(name)) continue; // window[0], window[1]…: iframes da página, não globais
      let value;
      try {
        value = window[name];
      } catch (e) {}
      if (isNativeFunction(value)) continue;
      added.push(name);
    }

    const natives = [];
    for (const [key, [path, prop, original]] of nativeRefs) {
      try {
        const current = resolvePath(path)[prop];
        if (current !== original) natives.push({ name: key, by: wrapperAuthor(current) });
      } catch (e) {}
    }

    const beefScripts = Array.from(document.scripts)
      .map((s) => s.src)
      .filter((src) => /\/hook\.js(\?|#|$)/i.test(src));

    post({
      kind: "globals",
      addedCount: added.length,
      added: added.slice(0, 80),
      known: added.filter((n) => KNOWN_GLOBALS[n]).map((n) => ({ name: n, label: KNOWN_GLOBALS[n] })),
      natives,
      beef: added.some((n) => BEEF_GLOBALS.includes(n)) || beefScripts.length > 0,
      beefScripts
    });
  }

  // Reverifica ao longo do tempo: scripts injetados tardiamente (ou após um
  // clique, como no teste js-leaks do DDG) também são pegos. Começa no
  // DOMContentLoaded: em portais com muitos anúncios o load demora demais.
  document.addEventListener("DOMContentLoaded", () => {
    for (const delay of [3000, 10000, 30000]) setTimeout(checkGlobals, delay);
    setTimeout(() => setInterval(checkGlobals, 60000), 30000);
  });

  // Verificação sob demanda: o popup pede um retrato atualizado ao abrir
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.__privacyGuardCmd === token && event.data.cmd === "checkGlobals") {
      checkGlobals();
    }
  });
}

// Modo fallback (<script src>): o token vem no atributo data do próprio script.
// No content script document.currentScript é null, então nada é executado.
if (document.currentScript && document.currentScript.dataset.privacyGuard) {
  privacyGuardPageHook(document.currentScript.dataset.privacyGuard);
}
