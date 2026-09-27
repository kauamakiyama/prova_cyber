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

  function post(data) {
    data.__privacyGuard = token;
    window.postMessage(data, "*");
  }

  // URL do script que chamou a API: pula os frames do próprio hook na pilha
  function callerScript() {
    const lines = (new Error().stack || "").split("\n").slice(2);
    for (const line of lines) {
      const m = line.match(/(https?:\/\/[^\s)]+?):\d+:\d+/);
      if (m) return m[1];
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Web Storage (localStorage / sessionStorage)
  // -------------------------------------------------------------------------
  function storageName(storage) {
    try {
      if (storage === window.localStorage) return "localStorage";
      if (storage === window.sessionStorage) return "sessionStorage";
    } catch (e) {
      // acesso ao storage bloqueado (ex.: iframe de 3ª parte sem permissão)
    }
    return "storage";
  }

  const origSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
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

  // -------------------------------------------------------------------------
  // IndexedDB
  // -------------------------------------------------------------------------
  const origOpen = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (name) {
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
}

// Modo fallback (<script src>): o token vem no atributo data do próprio script.
// No content script document.currentScript é null, então nada é executado.
if (document.currentScript && document.currentScript.dataset.privacyGuard) {
  privacyGuardPageHook(document.currentScript.dataset.privacyGuard);
}
