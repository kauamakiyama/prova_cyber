"use strict";

// ---------------------------------------------------------------------------
// Domínio registrável (eTLD+1)
// ---------------------------------------------------------------------------
// Sem build não dá para empacotar a Public Suffix List completa, então usamos
// uma lista reduzida dos sufixos compostos mais comuns. Para qualquer outro
// domínio, o eTLD+1 é considerado os dois últimos rótulos.
const MULTI_PART_SUFFIXES = new Set([
  "com.br", "net.br", "org.br", "gov.br", "edu.br", "art.br", "blog.br",
  "co.uk", "org.uk", "ac.uk", "gov.uk",
  "com.au", "net.au", "org.au",
  "co.jp", "ne.jp", "or.jp",
  "com.ar", "com.mx", "com.pt", "co.in", "co.nz", "co.za",
  "github.io", "herokuapp.com", "vercel.app", "netlify.app",
  "blogspot.com", "cloudfront.net", "appspot.com"
]);

function getHostname(url) {
  try {
    // Remove o ponto final de FQDNs ("example.com." -> "example.com")
    return new URL(url).hostname.replace(/\.$/, "");
  } catch (e) {
    return null;
  }
}

function getBaseDomain(hostname) {
  if (!hostname) return null;
  // IPs não têm eTLD+1: o próprio IP é o "site"
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) || hostname.includes(":")) {
    return hostname;
  }
  const labels = hostname.split(".");
  if (labels.length <= 2) return hostname;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_PART_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join(".");
  }
  return lastTwo;
}

function isThirdParty(requestHost, pageHost) {
  const a = getBaseDomain(requestHost);
  const b = getBaseDomain(pageHost);
  return !!a && !!b && a !== b;
}

// ---------------------------------------------------------------------------
// Estado por aba
// ---------------------------------------------------------------------------
// tabData[tabId] = {
//   pageUrl, pageHost, startedAt,
//   totalRequests,
//   thirdParty: { [baseDomain]: { hosts: Set, count, types: { [type]: n } } },
//   cookies: { [nome|domínio|path]: { name, domain, path, thirdParty, session, ... } },
//   storage: { [origem do frame]: { thirdParty, localStorage: Set, sessionStorage: Set,
//              indexedDB: Set, blocked: Set, writes, scripts: Set } },
//   navigation: { chain: [{ url, host, params, exit?, status?, dwell?, cookies?, storage? }] },
//   pendingRedirect: { to, status } | null,
//   userGesture: boolean (usuário clicou/teclou no documento principal),
//   cookieValues: { [valor]: { name, domain } },
//   pageValues: { [valor]: "cookie:nome" | "localStorage:chave" | ... },
//   syncs: { [chave]: { method, from, to, params, count } },
//   canvas: { [método|script|fingerprint|webgl]: { method, script, fingerprint, ... } },
//   sockets: { [host]: { count, urls: Set } },
//   endpoints: { [host+path]: { host, path, times: [ms] } },
//   globals: último relatório de globais/funções nativas do inject.js | null,
//   blocked: { [regra da lista]: { count, hosts: Set, types: { [tipo]: n } } }
// }
const tabData = {};

function resetTab(tabId, url, chain) {
  tabData[tabId] = {
    pageUrl: url,
    pageHost: getHostname(url),
    startedAt: Date.now(),
    totalRequests: 0,
    thirdParty: {},
    cookies: {},
    storage: {},
    navigation: { chain: chain || [newHop(url)] },
    pendingRedirect: null,
    userGesture: false,
    cookieValues: {},
    pageValues: {},
    syncs: {},
    canvas: {},
    sockets: {},
    endpoints: {},
    globals: null,
    blocked: {}
  };
  updateBadge(tabId);
}

function getTab(tabId) {
  return tabData[tabId] || null;
}

// Extensão carregada com a aba já aberta: inicializa usando a origem do documento
function ensureTab(details) {
  let tab = getTab(details.tabId);
  if (!tab) {
    const origin = details.documentUrl || details.originUrl;
    if (!origin) return null;
    resetTab(details.tabId, origin);
    tab = getTab(details.tabId);
  }
  return tab;
}

// ---------------------------------------------------------------------------
// Lista de bloqueio personalizada (browser.storage.local, chave "blocklist")
// ---------------------------------------------------------------------------
// Cada entrada é um domínio; bloqueia o próprio domínio e todos os subdomínios
// (ex.: "doubleclick.net" bloqueia "securepubads.g.doubleclick.net").
let blocklist = [];

browser.storage.local.get("blocklist").then(({ blocklist: list }) => {
  blocklist = Array.isArray(list) ? list : [];
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.blocklist) {
    blocklist = changes.blocklist.newValue || [];
  }
});

function matchBlocklist(host) {
  return blocklist.find((d) => host === d || host.endsWith("." + d)) || null;
}

function recordBlocked(tab, rule, host, type) {
  let entry = tab.blocked[rule];
  if (!entry) entry = tab.blocked[rule] = { count: 0, hosts: new Set(), types: {} };
  entry.count++;
  entry.hosts.add(host);
  entry.types[type] = (entry.types[type] || 0) + 1;
}

// ---------------------------------------------------------------------------
// Detecção de requisições de terceira parte (e aplicação da lista de bloqueio)
// ---------------------------------------------------------------------------
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Nova navegação no frame principal: zera o relatório da aba. A navegação
    // em si nunca é bloqueada; a lista vale para os recursos da página.
    if (details.type === "main_frame") {
      if (details.tabId >= 0) startNavigation(details);
      return;
    }

    // A lista vale também para requisições sem aba (tabId -1), como as feitas
    // por service workers; essas só não entram no relatório de nenhuma aba
    const reqHost = getHostname(details.url);
    const rule = reqHost && matchBlocklist(reqHost);
    const tab = details.tabId >= 0 ? ensureTab(details) : null;

    if (rule) {
      // Requisição cancelada não chega a conectar: não entra nas estatísticas
      // de 3ª parte, só na contagem de bloqueios
      if (tab) {
        recordBlocked(tab, rule, reqHost, details.type);
        updateBadge(details.tabId);
      }
      return { cancel: true };
    }

    if (!tab) return;
    tab.totalRequests++;

    if (!reqHost || !isThirdParty(reqHost, tab.pageHost)) return;

    const base = getBaseDomain(reqHost);
    let entry = tab.thirdParty[base];
    if (!entry) {
      entry = tab.thirdParty[base] = { hosts: new Set(), count: 0, types: {} };
    }
    entry.hosts.add(reqHost);
    entry.count++;
    entry.types[details.type] = (entry.types[details.type] || 0) + 1;

    checkCookieLeak(tab, details.url, reqHost);
    trackPersistentChannel(tab, details);
    updateBadge(details.tabId);
  },
  { urls: ["<all_urls>"] },
  ["blocking"]
);

// ---------------------------------------------------------------------------
// Cookies injetados via cabeçalho Set-Cookie
// ---------------------------------------------------------------------------
// Interpreta uma linha Set-Cookie (RFC 6265). Retorna null se for inválida.
function parseSetCookie(line) {
  const parts = line.split(";");
  const nameValue = parts.shift();
  const eq = nameValue.indexOf("=");
  if (eq < 0) return null;

  const cookie = {
    name: nameValue.slice(0, eq).trim(),
    value: nameValue.slice(eq + 1).trim(),
    domain: null,
    path: "/",
    expires: null,
    maxAge: null,
    secure: false,
    httpOnly: false,
    sameSite: null
  };

  for (const part of parts) {
    const i = part.indexOf("=");
    const key = (i < 0 ? part : part.slice(0, i)).trim().toLowerCase();
    const val = i < 0 ? "" : part.slice(i + 1).trim();
    if (key === "domain" && val) cookie.domain = val.replace(/^\./, "").toLowerCase();
    else if (key === "path" && val) cookie.path = val;
    else if (key === "expires") {
      const t = Date.parse(val);
      if (!isNaN(t)) cookie.expires = t;
    }
    else if (key === "max-age" && /^-?\d+$/.test(val)) cookie.maxAge = parseInt(val, 10);
    else if (key === "secure") cookie.secure = true;
    else if (key === "httponly") cookie.httpOnly = true;
    else if (key === "samesite") cookie.sameSite = val;
  }
  return cookie;
}

// Max-Age tem precedência sobre Expires. Sem nenhum dos dois o cookie é de sessão.
// Retorna o instante de expiração, null (sessão) ou -1 (cookie sendo apagado).
function cookieExpiry(cookie) {
  const now = Date.now();
  if (cookie.maxAge !== null) {
    return cookie.maxAge <= 0 ? -1 : now + cookie.maxAge * 1000;
  }
  if (cookie.expires !== null) {
    return cookie.expires <= now ? -1 : cookie.expires;
  }
  return null;
}

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || !details.responseHeaders) return;
    const tab = ensureTab(details);
    if (!tab) return;

    const reqHost = getHostname(details.url);

    for (const header of details.responseHeaders) {
      if (header.name.toLowerCase() !== "set-cookie" || !header.value) continue;

      // O Firefox junta vários Set-Cookie da mesma resposta separados por quebra de linha
      for (const line of header.value.split("\n")) {
        const cookie = parseSetCookie(line);
        if (!cookie) continue;

        const expiry = cookieExpiry(cookie);
        if (expiry === -1) continue; // exclusão de cookie, não é injeção

        // Sem atributo Domain o cookie pertence ao host que respondeu
        const domain = cookie.domain || reqHost;
        const key = `${cookie.name}|${domain}|${cookie.path}`;

        tab.cookies[key] = {
          name: cookie.name,
          domain,
          path: cookie.path,
          setBy: reqHost,
          thirdParty: isThirdParty(domain, tab.pageHost),
          session: expiry === null,
          expires: expiry,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite
        };

        // Valores com cara de identificador ficam só em memória, para detectar
        // o mesmo valor sendo enviado na URL de outro domínio (cookie sync)
        if (isIdLikeValue(cookie.value)) {
          tab.cookieValues[cookie.value] = { name: cookie.name, domain };
        }
        if (cookie.value) tab.pageValues[cookie.value] = `cookie:${cookie.name}`;
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// ---------------------------------------------------------------------------
// Armazenamento HTML5 (eventos enviados pelo inject.js via content.js)
// ---------------------------------------------------------------------------
const STORAGE_APIS = ["localStorage", "sessionStorage", "indexedDB"];

function getStorageEntry(tab, frameUrl) {
  let origin;
  try {
    // Remove o ponto final de FQDNs, como em getHostname()
    origin = new URL(frameUrl).origin.replace(/\.(:\d+)?$/, "$1");
  } catch (e) {
    return null;
  }
  if (!/^https?:/.test(origin)) return null;

  let entry = tab.storage[origin];
  if (!entry) {
    entry = tab.storage[origin] = {
      thirdParty: isThirdParty(getHostname(frameUrl), tab.pageHost),
      localStorage: new Set(),
      sessionStorage: new Set(),
      indexedDB: new Set(),
      blocked: new Set(),
      writes: 0,
      scripts: new Set()
    };
  }
  return entry;
}

function handleStorageEvent(tab, frameUrl, ev) {
  const entry = getStorageEntry(tab, frameUrl);
  if (!entry) return;

  if (ev.kind === "storage") {
    if (STORAGE_APIS.includes(ev.api)) entry[ev.api].add(ev.key);
    if (ev.value) tab.pageValues[ev.value] = `${ev.api}:${ev.key}`;
    entry.writes++;
    if (ev.script) entry.scripts.add(ev.script);
  } else if (ev.kind === "snapshot") {
    for (const api of STORAGE_APIS) {
      if (ev[api] === null) {
        // indexedDB.databases() indisponível não significa bloqueio
        if (api !== "indexedDB") entry.blocked.add(api);
        continue;
      }
      for (const key of ev[api]) entry[api].add(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Canvas fingerprint (eventos enviados pelo inject.js)
// ---------------------------------------------------------------------------
// A classificação (fingerprint ou simples leitura) é feita no inject.js, que vê
// o que foi desenhado no canvas. Aqui só se agrega e se marca 1ª/3ª parte pelo
// script que extraiu a imagem (ou pelo frame, se a pilha não tiver URL).
function handleCanvasEvent(tab, frameUrl, ev) {
  const key = `${ev.method}|${ev.script}|${ev.fingerprint}|${ev.webgl}`;
  if (tab.canvas[key]) {
    tab.canvas[key].count++; // outro canvas extraído pelo mesmo script/método
    return;
  }

  const scriptHost = getHostname(ev.script);
  tab.canvas[key] = {
    count: 1,
    method: ev.method,
    script: ev.script,
    frame: getHostname(frameUrl),
    thirdParty: isThirdParty(scriptHost || getHostname(frameUrl), tab.pageHost),
    width: ev.width,
    height: ev.height,
    format: ev.format,
    chars: ev.chars,
    colors: ev.colors,
    webgl: ev.webgl,
    fingerprint: ev.fingerprint
  };
}

// ---------------------------------------------------------------------------
// Hijacking / hook: canais persistentes com 3ª parte
// ---------------------------------------------------------------------------
// Polling: o mesmo endpoint de 3ª parte chamado repetidamente, espalhado no
// tempo. Um canal assim permite a um terceiro receber dados continuamente e
// devolver comandos para a página (é como o hook do BeEF se comunica).
const POLLING_MIN_REQUESTS = 4;
const POLLING_MIN_SPAN_MS = 20000;
const POLLING_TYPES = new Set(["xmlhttprequest", "beacon", "ping", "image", "script", "other"]);
const MAX_TIMES = 60;

function trackPersistentChannel(tab, details) {
  const host = getHostname(details.url);

  if (details.type === "websocket") {
    let entry = tab.sockets[host];
    if (!entry) entry = tab.sockets[host] = { count: 0, urls: new Set() };
    entry.count++;
    entry.urls.add(details.url.split("?")[0]);
    return;
  }

  if (!POLLING_TYPES.has(details.type)) return;
  let path;
  try {
    path = new URL(details.url).pathname;
  } catch (e) {
    return;
  }
  const key = host + path;
  let entry = tab.endpoints[key];
  if (!entry) entry = tab.endpoints[key] = { host, path, times: [] };
  entry.times.push(Date.now());
  if (entry.times.length > MAX_TIMES) entry.times.shift();
}

// Requisições a menos de 2 s umas das outras formam uma "rodada" (ex.: um leilão
// de anúncios dispara várias de uma vez). Polling = rodadas que se repetem.
const ROUND_GAP_MS = 2000;

function pollingReport(tab) {
  const result = [];
  for (const e of Object.values(tab.endpoints)) {
    const n = e.times.length;
    const span = n ? e.times[n - 1] - e.times[0] : 0;
    if (n < POLLING_MIN_REQUESTS || span < POLLING_MIN_SPAN_MS) continue;

    const rounds = [e.times[0]];
    for (let i = 1; i < n; i++) {
      if (e.times[i] - e.times[i - 1] > ROUND_GAP_MS) rounds.push(e.times[i]);
    }
    if (rounds.length < POLLING_MIN_REQUESTS) continue;

    const gaps = rounds.slice(1).map((t, i) => t - rounds[i]).sort((a, b) => a - b);
    result.push({
      host: e.host,
      path: e.path,
      count: n,
      rounds: rounds.length,
      spanSeconds: Math.round(span / 1000),
      intervalSeconds: Math.round(gaps[Math.floor(gaps.length / 2)] / 1000)
    });
  }
  return result.sort((a, b) => b.rounds - a.rounds);
}

// ---------------------------------------------------------------------------
// Navegação: bounce tracking, parâmetros de rastreamento e cookie sync
// ---------------------------------------------------------------------------
// Página de outro site que redireciona por JavaScript antes desse tempo é
// tratada como salto intermediário (bounce). A página de bounce do DDG
// redireciona imediatamente com location.href.
const CLIENT_BOUNCE_MS = 5000;
const MAX_CHAIN = 10;

// Parâmetros de rastreamento conhecidos: click IDs de plataformas de anúncio
// e marcação de campanha (listas usadas por Firefox, Brave e DuckDuckGo)
const TRACKING_PARAMS = new Set([
  "gclid", "dclid", "gbraid", "wbraid", "gclsrc", "_gl",
  "fbclid", "fb_source", "fb_ref", "fb_action_ids",
  "msclkid", "yclid", "twclid", "ttclid", "li_fat_id", "igshid",
  "mc_eid", "mc_cid", "oly_enc_id", "oly_anon_id", "vero_id",
  "_openstat", "wickedid", "rb_clickid", "s_cid", "ScCid", "epik", "rdt_cid"
].map((p) => p.toLowerCase()));
const TRACKING_PARAM_PREFIXES = ["utm_", "_hs", "pk_", "mtm_"];

// Nome de parâmetro que sugere identificador de usuário/dispositivo
const ID_PARAM_NAME = /uid|uuid|guid|user_?id|visitor_?id|client_?id|device_?id|partner_?id|buyer_?id/i;

function isTrackingParam(name) {
  const n = name.toLowerCase();
  return TRACKING_PARAMS.has(n) || TRACKING_PARAM_PREFIXES.some((p) => n.startsWith(p));
}

// Valor com cara de identificador: letras e dígitos misturados, ou número muito
// longo. Números curtos, datas e timestamps (10-13 dígitos) ficam de fora.
function isIdLikeValue(value) {
  if (!value || value.length < 8 || value.length > 256) return false;
  if (/^\d+$/.test(value)) return value.length >= 16;
  return /\d/.test(value) && /[a-z]/i.test(value) && /^[\w.\-~%|:=]+$/.test(value);
}

function analyzeParams(url) {
  const result = { tracking: [], ids: [] };
  let params;
  try {
    params = new URL(url).searchParams;
  } catch (e) {
    return result;
  }
  for (const [name, value] of params) {
    if (isTrackingParam(name)) result.tracking.push(name);
    else if (value && (ID_PARAM_NAME.test(name) || (value.length >= 16 && isIdLikeValue(value)))) {
      result.ids.push(name);
    }
  }
  return result;
}

function newHop(url) {
  return { url, host: getHostname(url), params: analyzeParams(url) };
}

// Chaves de armazenamento gravadas pela página (para registrar no salto de bounce)
function storageKeys(tab) {
  const keys = [];
  for (const entry of Object.values(tab.storage)) {
    for (const api of STORAGE_APIS) {
      for (const key of entry[api]) keys.push(`${api}:${key}`);
    }
  }
  return keys;
}

// Redirect por JavaScript/meta refresh: a nova navegação foi iniciada pela
// própria página anterior, que ficou aberta por pouco tempo e sem nenhuma
// interação do usuário (clique/tecla). Se é bounce ou não (outro site) é
// decidido em navigationReport().
function isClientRedirect(prev, details, now) {
  return !prev.userGesture &&
    now - prev.startedAt <= CLIENT_BOUNCE_MS &&
    getHostname(details.originUrl) === prev.pageHost;
}

function startNavigation(details) {
  const prev = getTab(details.tabId);
  const now = Date.now();
  let chain = null;
  let exit = null;

  if (prev && prev.pendingRedirect && prev.pendingRedirect.to === details.url) {
    exit = { exit: "server", status: prev.pendingRedirect.status };
  } else if (prev && isClientRedirect(prev, details, now)) {
    exit = { exit: "client", dwell: now - prev.startedAt };
  }

  if (exit) {
    chain = prev.navigation.chain.slice(-(MAX_CHAIN - 1));
    if (getHostname(details.url) === prev.pageHost) {
      // Mesmo host (ex.: upgrade interno http -> https do Firefox, status 0,
      // ou normalização de caminho): não é um salto, só atualiza a URL
      chain[chain.length - 1] = newHop(details.url);
    } else {
      // Continua a cadeia: registra como a página anterior saiu e o que ela gravou
      Object.assign(chain[chain.length - 1], exit, {
        cookies: Object.values(prev.cookies).map((c) => c.name),
        storage: storageKeys(prev),
        values: Object.assign({}, prev.pageValues)
      });
      chain.push(newHop(details.url));
    }
  }

  resetTab(details.tabId, details.url, chain);
}

// Gravação que chegou depois que a aba já navegou: a página de bounce grava o
// ID e redireciona na sequência, então a mensagem do content script pode chegar
// quando a próxima página já começou. Atribui ao salto correspondente da cadeia.
function handleLateHopEvent(tab, frameUrl, ev) {
  if (ev.kind !== "storage") return;
  const hops = tab.navigation.chain.slice(0, -1);
  const hop = hops.find((h) => h.url === frameUrl) ||
    hops.find((h) => h.host === getHostname(frameUrl));
  if (!hop) return;

  const key = `${ev.api}:${ev.key}`;
  if (!hop.storage.includes(key)) hop.storage.push(key);
  if (ev.value) hop.values[ev.value] = key;
}

function addSync(tab, sync) {
  const key = `${sync.method}|${sync.from}|${sync.to}|${sync.params.join(",")}`;
  if (tab.syncs[key]) tab.syncs[key].count++;
  else tab.syncs[key] = Object.assign({ count: 1 }, sync);
}

// Valor de um cookie de um domínio aparecendo na URL de requisição a outro domínio
function checkCookieLeak(tab, url, reqHost) {
  const reqBase = getBaseDomain(reqHost);
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch (e) {}

  for (const [value, c] of Object.entries(tab.cookieValues)) {
    if (getBaseDomain(c.domain) === reqBase) continue;
    if (url.includes(value) || decoded.includes(value)) {
      addSync(tab, { method: "cookie", from: c.domain, to: reqHost, params: [c.name] });
    }
  }
}

browser.webRequest.onBeforeRedirect.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const tab = getTab(details.tabId);
    if (!tab) return;

    // Redirect HTTP da navegação principal: a próxima main_frame continua a cadeia
    if (details.type === "main_frame") {
      tab.pendingRedirect = { to: details.redirectUrl, status: details.statusCode };
      return;
    }

    // Subrecurso redirecionado de um domínio de 3ª parte para outro levando
    // um identificador na URL: padrão de pixel de sincronização de cookies
    const fromHost = getHostname(details.url);
    const toHost = getHostname(details.redirectUrl);
    if (!fromHost || !toHost) return;
    if (!isThirdParty(fromHost, tab.pageHost) || !isThirdParty(toHost, tab.pageHost)) return;
    if (!isThirdParty(fromHost, toHost)) return;

    const { ids } = analyzeParams(details.redirectUrl);
    if (ids.length) addSync(tab, { method: "redirect", from: fromHost, to: toHost, params: ids });
  },
  { urls: ["<all_urls>"] }
);

// ---------------------------------------------------------------------------
// Badge e limpeza
// ---------------------------------------------------------------------------
function updateBadge(tabId) {
  const tab = getTab(tabId);
  const n = tab ? Object.keys(tab.thirdParty).length : 0;
  browser.browserAction.setBadgeText({ tabId, text: n ? String(n) : "" })
    .catch(() => {}); // aba pode ter sido fechada
  browser.browserAction.setBadgeBackgroundColor({ tabId, color: "#c0392b" })
    .catch(() => {});
}

browser.tabs.onRemoved.addListener((tabId) => {
  delete tabData[tabId];
});

// ---------------------------------------------------------------------------
// Comunicação com o popup
// ---------------------------------------------------------------------------
// Saltos intermediários de outro eTLD+1 que o destino final = bounce tracking.
// "passed": parâmetro da URL final cujo valor é igual a um cookie/storage
// gravado por um salto intermediário, ou seja, o ID foi repassado pela URL.
function navigationReport(tab) {
  const fullChain = tab.navigation.chain;
  const final = fullChain[fullChain.length - 1];
  const finalBase = getBaseDomain(final.host);

  const passed = [];
  let params = [];
  try {
    params = new URL(final.url).searchParams;
  } catch (e) {}
  for (const [name, value] of params) {
    if (value.length < 2) continue;
    const hop = fullChain.slice(0, -1).find((h) => h.values && h.values[value]);
    if (hop) passed.push({ param: name, host: hop.host, source: hop.values[value] });
  }

  // Os valores gravados ficam só no background, não vão para o popup
  const chain = fullChain.map(({ values, ...hop }) => hop);
  return {
    chain,
    bounces: chain.slice(0, -1).filter((hop) => getBaseDomain(hop.host) !== finalBase),
    passed
  };
}

// ---------------------------------------------------------------------------
// Score de privacidade
// ---------------------------------------------------------------------------
// A página começa com 100 pontos e perde pontos em 7 critérios. Cada critério
// tem um teto (peso); os pesos somam 100. Metodologia e justificativa no README.
// Globais -> fornecedor. A contagem é por fornecedor: fbq e _fbq são o mesmo
// Meta Pixel, hj e _hjSettings o mesmo Hotjar.
const SESSION_REPLAY_GLOBALS = {
  clarity: "Microsoft Clarity", hj: "Hotjar", _hjSettings: "Hotjar", FS: "FullStory"
};
const PIXEL_GLOBALS = {
  fbq: "Meta Pixel", _fbq: "Meta Pixel", ttq: "TikTok Pixel",
  uetq: "Microsoft UET", _linkedin_partner_id: "LinkedIn Insight Tag"
};

function vendorsOf(names, table) {
  return [...new Set(names.filter((n) => table[n]).map((n) => table[n]))];
}

function scoreGrade(score) {
  if (score >= 85) return "Boa";
  if (score >= 65) return "Moderada";
  if (score >= 40) return "Ruim";
  return "Crítica";
}

function computeScore(r) {
  const criteria = [];
  function add(id, label, weight, raw, detail) {
    const penalty = Math.min(weight, Math.round(raw * 10) / 10);
    criteria.push({ id, label, weight, penalty, detail });
  }

  // 1. Domínios de 3ª parte: cada terceiro recebe IP, User-Agent e Referer
  add("third-party", "Domínios de 3ª parte", 20, r.thirdParty.length,
    `${r.thirdParty.length} domínio(s) × 1`);

  // 2. Cookies de 3ª parte: persistentes pesam o dobro (sobrevivem à sessão)
  const c3 = r.cookies.filter((c) => c.thirdParty);
  const c3p = c3.filter((c) => !c.session).length;
  const c3s = c3.length - c3p;
  add("cookies", "Cookies de 3ª parte", 20, c3p * 2 + c3s,
    `${c3p} persistente(s) × 2 + ${c3s} de sessão × 1`);

  // 3. Ligação de identidades entre domínios
  const nav = r.navigation;
  const final = nav.chain[nav.chain.length - 1];
  const linking = r.syncs.length + nav.bounces.length + nav.passed.length;
  add("linking", "Cookie sync, bounce e IDs na URL", 15,
    linking * 5 + final.params.ids.length * 3 + final.params.tracking.length * 2,
    `${r.syncs.length} sync + ${nav.bounces.length} bounce + ${nav.passed.length} ID repassado (× 5), ` +
    `${final.params.ids.length} identificador(es) × 3, ${final.params.tracking.length} parâmetro(s) de rastreamento × 2`);

  // 4. Canvas fingerprint: identifica sem cookie; 3ª parte pesa mais
  const fp = r.canvas.filter((c) => c.fingerprint);
  const fp3 = fp.some((c) => c.thirdParty);
  add("canvas", "Canvas fingerprint", 15, fp3 ? 15 : fp.length ? 10 : 0,
    fp.length ? `${fp.length} extração(ões) de fingerprint${fp3 ? " por script de 3ª parte" : " (1ª parte)"}` : "nenhuma");

  // 5. Session replay e pixels de rastreamento (equivalem a testes do Blacklight)
  const g = r.hijack.globals;
  const known = g ? g.known.map((k) => k.name) : [];
  const replay = vendorsOf(known, SESSION_REPLAY_GLOBALS);
  const pixels = vendorsOf(known, PIXEL_GLOBALS);
  add("replay-pixels", "Session replay e pixels", 10, replay.length * 5 + pixels.length * 3,
    g ? `session replay: ${replay.join(", ") || "nenhum"} (× 5); pixels: ${pixels.join(", ") || "nenhum"} (× 3)`
      : "globais ainda não verificadas");

  // 6. Hijacking/hook: BeEF zera o critério
  const h = r.hijack;
  const natives = g ? g.natives : [];
  const nUnknown = natives.filter((n) => !n.by).length;
  const nKnown = natives.length - nUnknown;
  add("hijack", "Hijacking/hook", 10,
    g && g.beef ? 10 : h.sockets.length * 4 + h.polling.length * 2 + nUnknown * 2 + nKnown * 0.5,
    g && g.beef ? "assinatura do BeEF"
      : `${h.sockets.length} WebSocket × 4, ${h.polling.length} polling × 2, ` +
        `${nUnknown} nativa(s) sem autor × 2, ${nKnown} com autor conhecido × 0,5`);

  // 7. Armazenamento: chaves de 3ª parte guardam IDs fora do alcance dos cookies
  const keys = (third) => r.storage.filter((s) => s.thirdParty === third)
    .reduce((n, s) => n + s.localStorage.length + s.sessionStorage.length + s.indexedDB.length, 0);
  const k3 = keys(true);
  const k1 = keys(false);
  add("storage", "Armazenamento de 3ª parte", 10, k3 * 2 + Math.floor(k1 / 20),
    `${k3} chave(s) de 3ª parte × 2 + ${k1} de 1ª parte ÷ 20`);

  const total = criteria.reduce((n, c) => n + c.penalty, 0);
  let score = Math.max(0, Math.round(100 - total));

  // BeEF não é rastreamento, é comprometimento ativo do navegador: por mais
  // limpa que a página seja no resto, o score fica no máximo em 20 (Crítica)
  const beefCap = !!(g && g.beef);
  if (beefCap) score = Math.min(score, 20);

  return { score, grade: scoreGrade(score), criteria, partial: !g, beefCap };
}

function serializeReport(tab) {
  const thirdParty = Object.entries(tab.thirdParty)
    .map(([domain, e]) => ({
      domain,
      hosts: [...e.hosts],
      count: e.count,
      types: e.types
    }))
    .sort((a, b) => b.count - a.count);

  const cookies = Object.values(tab.cookies)
    .sort((a, b) => (b.thirdParty - a.thirdParty) || a.domain.localeCompare(b.domain));

  const cookieSummary = { total: cookies.length, firstParty: 0, thirdParty: 0, session: 0, persistent: 0 };
  for (const c of cookies) {
    cookieSummary[c.thirdParty ? "thirdParty" : "firstParty"]++;
    cookieSummary[c.session ? "session" : "persistent"]++;
  }

  const storage = Object.entries(tab.storage)
    .map(([origin, e]) => ({
      origin,
      thirdParty: e.thirdParty,
      localStorage: [...e.localStorage],
      sessionStorage: [...e.sessionStorage],
      indexedDB: [...e.indexedDB],
      blocked: [...e.blocked],
      writes: e.writes,
      scripts: [...e.scripts]
    }))
    .filter((s) => STORAGE_APIS.some((api) => s[api].length) || s.blocked.length)
    .sort((a, b) => a.thirdParty - b.thirdParty);

  const report = {
    pageUrl: tab.pageUrl,
    pageHost: tab.pageHost,
    pageBaseDomain: getBaseDomain(tab.pageHost),
    totalRequests: tab.totalRequests,
    thirdPartyRequests: thirdParty.reduce((s, d) => s + d.count, 0),
    thirdParty,
    cookies,
    cookieSummary,
    storage,
    navigation: navigationReport(tab),
    syncs: Object.values(tab.syncs),
    canvas: Object.values(tab.canvas).sort((a, b) => b.fingerprint - a.fingerprint),
    hijack: {
      sockets: Object.entries(tab.sockets).map(([host, e]) => ({ host, count: e.count, urls: [...e.urls] })),
      polling: pollingReport(tab),
      globals: tab.globals
    },
    blocked: Object.entries(tab.blocked)
      .map(([rule, e]) => ({ rule, count: e.count, hosts: [...e.hosts], types: e.types }))
      .sort((a, b) => b.count - a.count)
  };
  report.score = computeScore(report);
  return report;
}

// Ao abrir o popup, pede ao documento principal um retrato atualizado das
// globais/funções nativas e dá um instante para a resposta chegar
async function refreshPage(tabId) {
  try {
    await browser.tabs.sendMessage(tabId, { type: "checkGlobals" }, { frameId: 0 });
    await new Promise((resolve) => setTimeout(resolve, 300));
  } catch (e) {
    // página sem content script (about:, loja de extensões etc.)
  }
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;

  if (msg.type === "getReport") {
    return refreshPage(msg.tabId).then(() => {
      const tab = getTab(msg.tabId);
      return tab ? serializeReport(tab) : null;
    });
  }

  if (msg.type === "userGesture" && sender.tab) {
    const tab = getTab(sender.tab.id);
    if (tab && getHostname(sender.url) === tab.pageHost) tab.userGesture = true;
    return;
  }

  if (msg.type === "pageEvent" && sender.tab) {
    const tab = ensureTab({ tabId: sender.tab.id, documentUrl: sender.tab.url });
    if (!tab) return;
    // Evento do frame principal de outro host = página anterior (ver handleLateHopEvent)
    if (sender.frameId === 0 && getHostname(sender.url) !== tab.pageHost) {
      handleLateHopEvent(tab, sender.url, msg.event);
    } else if (msg.event.kind === "canvas") {
      handleCanvasEvent(tab, sender.url, msg.event);
    } else if (msg.event.kind === "globals") {
      if (sender.frameId === 0) tab.globals = msg.event; // último retrato substitui o anterior
    } else {
      handleStorageEvent(tab, sender.url, msg.event);
    }
  }
});
