"use strict";

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderThirdParty(report) {
  const list = document.getElementById("third-party");
  list.textContent = "";

  document.getElementById("summary").textContent =
    `${report.thirdParty.length} domínio(s) · ` +
    `${report.thirdPartyRequests} de ${report.totalRequests} requisições são de 3ª parte`;

  for (const d of report.thirdParty) {
    const li = el("li");
    const head = el("div", "domain");
    const actions = el("span", "actions");
    if (blocklist.includes(d.domain)) {
      actions.append(el("span", "tag third", "na lista"));
    } else {
      const button = el("button", "danger", "Bloquear");
      button.title = `Adicionar ${d.domain} (e subdomínios) à lista de bloqueio`;
      button.addEventListener("click", () => addToBlocklist(d.domain));
      actions.append(button);
    }
    actions.append(el("span", "count", d.count));
    head.append(el("span", "", d.domain), actions);

    const types = Object.entries(d.types).map(([t, n]) => `${t}×${n}`).join(", ");
    li.append(
      head,
      el("div", "details", d.hosts.join(", ")),
      el("div", "details", types)
    );
    list.append(li);
  }
}

function renderCookies(report) {
  const rows = { "1ª parte": { s: 0, p: 0 }, "3ª parte": { s: 0, p: 0 } };
  for (const c of report.cookies) {
    rows[c.thirdParty ? "3ª parte" : "1ª parte"][c.session ? "s" : "p"]++;
  }

  const tbody = document.querySelector("#cookie-summary tbody");
  tbody.textContent = "";
  for (const [label, r] of Object.entries(rows)) {
    const tr = el("tr");
    tr.append(el("td", "", label), el("td", "", r.s), el("td", "", r.p), el("td", "", r.s + r.p));
    tbody.append(tr);
  }
  const total = el("tr");
  const s = report.cookieSummary;
  total.append(el("th", "", "Total"), el("th", "", s.session), el("th", "", s.persistent), el("th", "", s.total));
  tbody.append(total);

  const list = document.getElementById("cookies");
  list.textContent = "";
  for (const c of report.cookies) {
    const li = el("li");
    const head = el("div", "domain");
    const name = el("span", "", c.name);
    name.append(
      el("span", c.thirdParty ? "tag third" : "tag", c.thirdParty ? "3ª" : "1ª"),
      el("span", c.session ? "tag" : "tag persistent", c.session ? "sessão" : "persistente")
    );
    head.append(name);

    const flags = [
      c.expires ? `expira ${new Date(c.expires).toLocaleDateString("pt-BR")}` : null,
      c.secure ? "Secure" : null,
      c.httpOnly ? "HttpOnly" : null,
      c.sameSite ? `SameSite=${c.sameSite}` : null
    ].filter(Boolean).join(" · ");

    li.append(
      head,
      el("div", "details", `${c.domain}${c.path} (definido por ${c.setBy})`),
      el("div", "details", flags)
    );
    list.append(li);
  }
}

const STORAGE_APIS = ["localStorage", "sessionStorage", "indexedDB"];

function renderStorage(report) {
  const tbody = document.querySelector("#storage-summary tbody");
  tbody.textContent = "";
  for (const api of STORAGE_APIS) {
    const count = (third) => report.storage
      .filter((s) => s.thirdParty === third)
      .reduce((n, s) => n + s[api].length, 0);
    const tr = el("tr");
    tr.append(el("td", "", api), el("td", "", count(false)), el("td", "", count(true)));
    tbody.append(tr);
  }

  const list = document.getElementById("storage");
  list.textContent = "";
  for (const s of report.storage) {
    const li = el("li");
    const head = el("div", "domain");
    const origin = el("span", "", s.origin);
    origin.append(el("span", s.thirdParty ? "tag third" : "tag", s.thirdParty ? "3ª" : "1ª"));
    head.append(origin);
    li.append(head);

    for (const api of STORAGE_APIS) {
      if (s[api].length) {
        li.append(el("div", "details", `${api} (${s[api].length}): ${s[api].join(", ")}`));
      }
    }
    if (s.blocked.length) {
      li.append(el("div", "details", `acesso bloqueado: ${s.blocked.join(", ")}`));
    }
    if (s.scripts.length) {
      li.append(el("div", "details", `gravado por: ${s.scripts.join(", ")}`));
    }
    list.append(li);
  }
}

function paramTags(parent, params) {
  for (const p of params.tracking) parent.append(el("span", "tag persistent", p));
  for (const p of params.ids) parent.append(el("span", "tag third", p));
}

function renderNavigation(report) {
  const { chain, bounces, passed } = report.navigation;
  const final = chain[chain.length - 1];
  const bounceUrls = new Set(bounces.map((h) => h.url));

  document.getElementById("navigation-summary").textContent =
    `${bounces.length} salto(s) de bounce · ` +
    `${passed.length} ID(s) repassado(s) · ` +
    `${final.params.tracking.length} parâmetro(s) de rastreamento · ` +
    `${final.params.ids.length} identificador(es) na URL · ` +
    `${report.syncs.length} sincronização(ões)`;

  const list = document.getElementById("navigation");
  list.textContent = "";

  // Cadeia de navegação até a página atual
  if (chain.length > 1) {
    const li = el("li");
    li.append(el("div", "domain", "Cadeia de navegação"));
    for (const hop of chain.slice(0, -1)) {
      const line = el("div", "details");
      const how = hop.exit === "server"
        ? `redirect HTTP ${hop.status}`
        : `redirect por JavaScript após ${hop.dwell} ms`;
      line.append(el("strong", "", hop.host));
      if (bounceUrls.has(hop.url)) line.append(el("span", "tag third", "bounce"));
      line.append(` → ${how}`);
      const stored = hop.cookies.concat(hop.storage);
      if (stored.length) line.append(el("div", "", `cookies/storage no salto: ${stored.join(", ")}`));
      li.append(line);
    }
    const dest = el("div", "details");
    dest.append(el("strong", "", final.host), " (destino)");
    li.append(dest);
    list.append(li);
  }

  // Valor gravado por um salto intermediário que reaparece na URL de destino
  if (passed.length) {
    const li = el("li");
    li.append(el("div", "domain", "ID repassado pela URL"));
    for (const p of passed) {
      const line = el("div", "details");
      line.append(el("span", "tag third", p.param), ` = valor de ${p.source} gravado por ${p.host}`);
      li.append(line);
    }
    list.append(li);
  }

  // Parâmetros de rastreamento e identificadores na URL da página
  if (final.params.tracking.length || final.params.ids.length) {
    const li = el("li");
    li.append(el("div", "domain", "Parâmetros na URL da página"));
    const tags = el("div", "details");
    paramTags(tags, final.params);
    li.append(tags, el("div", "details", "laranja = rastreamento de campanha/clique · vermelho = identificador"));
    list.append(li);
  }

  // Cookie sync entre domínios
  for (const s of report.syncs) {
    const li = el("li");
    const head = el("div", "domain");
    head.append(el("span", "", `${s.from} → ${s.to}`), el("span", "count", s.count));
    const how = s.method === "cookie"
      ? `valor do cookie ${s.params.join(", ")} enviado na URL`
      : `redirect entre 3ª partes levando ${s.params.join(", ")}`;
    li.append(head, el("div", "details", how));
    list.append(li);
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch (e) {
    return null;
  }
}

function renderCanvas(report) {
  const fp = report.canvas.filter((c) => c.fingerprint);
  const reads = report.canvas.filter((c) => !c.fingerprint);
  const total = (list) => list.reduce((n, c) => n + c.count, 0);
  document.getElementById("canvas-summary").textContent =
    `${total(fp)} tentativa(s) de fingerprint · ${total(reads)} leitura(s) de canvas`;

  const list = document.getElementById("canvas");
  list.textContent = "";
  for (const c of report.canvas) {
    const li = el("li");
    const head = el("div", "domain");
    const who = el("span", "", hostOf(c.script) || c.frame);
    who.append(
      el("span", c.thirdParty ? "tag third" : "tag", c.thirdParty ? "3ª" : "1ª"),
      el("span", c.fingerprint ? "tag third" : "tag", c.fingerprint ? "fingerprint" : "leitura")
    );
    head.append(who, el("span", "count", c.count));

    const drawing = `desenho: ${c.chars} caractere(s) distinto(s), ${c.colors} cor(es)` +
      (c.webgl ? " · WebGL" : "");
    li.append(
      head,
      el("div", "details", `${c.method} · ${c.width}×${c.height} · ${c.format}`),
      el("div", "details", drawing)
    );
    if (c.script) li.append(el("div", "details", c.script));
    list.append(li);
  }
}

function renderHijack(report) {
  const { sockets, polling, globals } = report.hijack;
  const natives = globals ? globals.natives : [];
  document.getElementById("hijack-summary").textContent =
    `${sockets.length} WebSocket(s) de 3ª parte · ` +
    `${polling.length} polling(s) persistente(s) · ` +
    `${natives.length} função(ões) nativa(s) sobrescrita(s) · ` +
    `${globals ? globals.addedCount : 0} global(is) adicionada(s)` +
    (globals ? "" : " (verificação após o load)");

  const list = document.getElementById("hijack");
  list.textContent = "";

  if (globals && globals.beef) {
    const li = el("li");
    li.append(el("div", "alert", "Assinatura do BeEF (Browser Exploitation Framework) detectada"));
    if (globals.beefScripts.length) li.append(el("div", "details", globals.beefScripts.join(", ")));
    list.append(li);
  }

  for (const s of sockets) {
    const li = el("li");
    const head = el("div", "domain");
    const name = el("span", "", s.host);
    name.append(el("span", "tag third", "WebSocket 3ª"));
    head.append(name, el("span", "count", s.count));
    li.append(head, el("div", "details", s.urls.join(", ")));
    list.append(li);
  }

  for (const p of polling) {
    const li = el("li");
    const head = el("div", "domain");
    const name = el("span", "", p.host);
    name.append(el("span", "tag third", "polling 3ª"));
    head.append(name, el("span", "count", p.count));
    li.append(
      head,
      el("div", "details", p.path),
      el("div", "details",
        `${p.count} requisições em ${p.rounds} rodadas ao longo de ${p.spanSeconds} s · ` +
        `a cada ~${p.intervalSeconds} s`)
    );
    list.append(li);
  }

  if (natives.length) {
    const li = el("li");
    li.append(el("div", "domain", "Funções nativas sobrescritas"));
    const tags = el("div", "details");
    for (const n of natives) tags.append(el("span", "tag third", n.by ? `${n.name} (${n.by})` : n.name));
    li.append(tags, el("div", "details", "um script substituiu a função original do navegador (pode interceptar tráfego/eventos); entre parênteses, o provável autor"));
    list.append(li);
  }

  if (globals && globals.addedCount) {
    const li = el("li");
    li.append(el("div", "domain", `Globais adicionadas pela página (${globals.addedCount})`));
    for (const k of globals.known) {
      const line = el("div", "details");
      line.append(el("span", "tag persistent", k.name), ` ${k.label}`);
      li.append(line);
    }
    const known = new Set(globals.known.map((k) => k.name));
    const others = globals.added.filter((n) => !known.has(n));
    if (others.length) {
      const more = globals.addedCount - globals.added.length;
      li.append(el("div", "details", others.join(", ") + (more > 0 ? ` … (+${more})` : "")));
    }
    list.append(li);
  }
}

// ---------------------------------------------------------------------------
// Lista de bloqueio personalizada (browser.storage.local, chave "blocklist")
// ---------------------------------------------------------------------------
let blocklist = [];
let currentTabId = null;
let currentReport = null;

// Aceita "doubleclick.net", "*.doubleclick.net", "https://ads.x.com/path" ou IPv4
function normalizeDomain(input) {
  const d = String(input).trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/^\*\./, "")
    .replace(/^\.+|\.+$/g, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(d)) return d;
  return /^([a-z0-9-]+\.)+[a-z0-9-]{2,}$/.test(d) ? d : null;
}

async function saveBlocklist(list) {
  blocklist = [...new Set(list)].sort();
  await browser.storage.local.set({ blocklist });
  renderBlocklist();
  if (currentReport) renderThirdParty(currentReport);
  showReloadHint();
}

function addToBlocklist(domain) {
  return saveBlocklist(blocklist.concat(domain));
}

function removeFromBlocklist(domain) {
  return saveBlocklist(blocklist.filter((d) => d !== domain));
}

// A lista vale para as próximas requisições: o que já carregou continua na página
function showReloadHint() {
  const msg = document.getElementById("blocklist-message");
  msg.className = "muted";
  msg.textContent = "Lista atualizada. Recarregue a página para aplicar. ";
  if (currentTabId !== null) {
    const button = el("button", "", "Recarregar página");
    button.addEventListener("click", () => {
      browser.tabs.reload(currentTabId);
      window.close();
    });
    msg.append(button);
  }
}

function renderBlocklist() {
  const list = document.getElementById("blocklist");
  list.textContent = "";
  if (!blocklist.length) {
    list.append(el("li", "details", "Nenhum domínio na lista."));
    return;
  }
  for (const domain of blocklist) {
    const li = el("li");
    const head = el("div", "domain");
    const button = el("button", "", "Remover");
    button.addEventListener("click", () => removeFromBlocklist(domain));
    head.append(el("span", "", domain), button);
    li.append(head, el("div", "details", `bloqueia ${domain} e *.${domain}`));
    list.append(li);
  }
}

function renderBlocked(report) {
  const total = report.blocked.reduce((n, b) => n + b.count, 0);
  document.getElementById("blocked-summary").textContent =
    `${total} requisição(ões) bloqueada(s) pela lista personalizada`;

  const list = document.getElementById("blocked");
  list.textContent = "";
  for (const b of report.blocked) {
    const li = el("li");
    const head = el("div", "domain");
    const name = el("span", "", b.rule);
    name.append(el("span", "tag third", "bloqueado"));
    head.append(name, el("span", "count", b.count));
    const types = Object.entries(b.types).map(([t, n]) => `${t}×${n}`).join(", ");
    li.append(head, el("div", "details", b.hosts.join(", ")), el("div", "details", types));
    list.append(li);
  }
}

document.getElementById("blocklist-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("blocklist-input");
  const domain = normalizeDomain(input.value);
  const msg = document.getElementById("blocklist-message");
  if (!domain) {
    msg.className = "error";
    msg.textContent = "Domínio inválido. Use, por exemplo, doubleclick.net";
    return;
  }
  input.value = "";
  addToBlocklist(domain);
});

async function init() {
  const stored = await browser.storage.local.get("blocklist");
  blocklist = Array.isArray(stored.blocklist) ? stored.blocklist : [];
  renderBlocklist();

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  currentTabId = tab.id;
  const report = await browser.runtime.sendMessage({ type: "getReport", tabId: tab.id });

  if (!report) {
    document.getElementById("page").textContent =
      "Sem dados para esta aba. Recarregue a página.";
    return;
  }
  currentReport = report;

  document.getElementById("page").textContent =
    `${report.pageHost} (site: ${report.pageBaseDomain})`;
  renderThirdParty(report);
  renderBlocked(report);
  renderCookies(report);
  renderStorage(report);
  renderNavigation(report);
  renderCanvas(report);
  renderHijack(report);
}

init();
