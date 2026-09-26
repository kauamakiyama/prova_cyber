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
}

init();
