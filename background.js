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
//   cookies: { [nome|domínio|path]: { name, domain, path, thirdParty, session, ... } }
// }
const tabData = {};

function resetTab(tabId, url) {
  tabData[tabId] = {
    pageUrl: url,
    pageHost: getHostname(url),
    startedAt: Date.now(),
    totalRequests: 0,
    thirdParty: {},
    cookies: {}
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
      resetTab(details.tabId, details.url);
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
      }
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
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

  return {
    pageUrl: tab.pageUrl,
    pageHost: tab.pageHost,
    pageBaseDomain: getBaseDomain(tab.pageHost),
    totalRequests: tab.totalRequests,
    thirdPartyRequests: thirdParty.reduce((s, d) => s + d.count, 0),
    thirdParty,
    cookies,
    cookieSummary
  };
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "getReport") {
    const tab = getTab(msg.tabId);
    return Promise.resolve(tab ? serializeReport(tab) : null);
  }
});
