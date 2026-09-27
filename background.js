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
//   syncs: { [chave]: { method, from, to, params, count } }
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
    syncs: {}
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
// Detecção de requisições de terceira parte
// ---------------------------------------------------------------------------
browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return; // requisições que não pertencem a uma aba

    // Nova navegação no frame principal: zera o relatório da aba
    if (details.type === "main_frame") {
      startNavigation(details);
      return;
    }

    const tab = ensureTab(details);
    if (!tab) return;

    tab.totalRequests++;

    const reqHost = getHostname(details.url);
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
    updateBadge(details.tabId);
  },
  { urls: ["<all_urls>"] }
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
    // Continua a cadeia: registra como a página anterior saiu e o que ela gravou
    chain = prev.navigation.chain.slice(-(MAX_CHAIN - 1));
    Object.assign(chain[chain.length - 1], exit, {
      cookies: Object.values(prev.cookies).map((c) => c.name),
      storage: storageKeys(prev),
      values: Object.assign({}, prev.pageValues)
    });
    chain.push(newHop(details.url));
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

  return {
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
    syncs: Object.values(tab.syncs)
  };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg) return;

  if (msg.type === "getReport") {
    const tab = getTab(msg.tabId);
    return Promise.resolve(tab ? serializeReport(tab) : null);
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
    } else {
      handleStorageEvent(tab, sender.url, msg.event);
    }
  }
});
