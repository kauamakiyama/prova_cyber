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
    head.append(el("span", "", d.domain), el("span", "count", d.count));

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

async function init() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  const report = await browser.runtime.sendMessage({ type: "getReport", tabId: tab.id });

  if (!report) {
    document.getElementById("page").textContent =
      "Sem dados para esta aba. Recarregue a página.";
    return;
  }

  document.getElementById("page").textContent =
    `${report.pageHost} (site: ${report.pageBaseDomain})`;
  renderThirdParty(report);
  renderCookies(report);
  renderStorage(report);
  renderNavigation(report);
}

init();
