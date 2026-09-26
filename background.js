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
    return new URL(url).hostname;
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
//   thirdParty: { [baseDomain]: { hosts: Set, count, types: { [type]: n } } }
// }
const tabData = {};

function resetTab(tabId, url) {
  tabData[tabId] = {
    pageUrl: url,
    pageHost: getHostname(url),
    startedAt: Date.now(),
    totalRequests: 0,
    thirdParty: {}
  };
  updateBadge(tabId);
}

function getTab(tabId) {
  return tabData[tabId] || null;
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

    let tab = getTab(details.tabId);
    if (!tab) {
      // Extensão carregada com a aba já aberta: usa a origem do documento
      const origin = details.documentUrl || details.originUrl;
      if (!origin) return;
      resetTab(details.tabId, origin);
      tab = getTab(details.tabId);
    }

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

  return {
    pageUrl: tab.pageUrl,
    pageHost: tab.pageHost,
    pageBaseDomain: getBaseDomain(tab.pageHost),
    totalRequests: tab.totalRequests,
    thirdPartyRequests: thirdParty.reduce((s, d) => s + d.count, 0),
    thirdParty
  };
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "getReport") {
    const tab = getTab(msg.tabId);
    return Promise.resolve(tab ? serializeReport(tab) : null);
  }
});
