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
}

init();
