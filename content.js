"use strict";

// Ponte entre a página e o background: injeta o hook do inject.js no contexto
// da página e repassa ao background as mensagens que ele envia via postMessage.

// Token aleatório por frame: filtra mensagens que não vieram do nosso hook
const token = Math.random().toString(36).slice(2) + Date.now().toString(36);

function injectInline() {
  const script = document.createElement("script");
  script.textContent = `(${privacyGuardPageHook})(${JSON.stringify(token)});`;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

function injectSrc() {
  const script = document.createElement("script");
  script.src = browser.runtime.getURL("inject.js");
  script.dataset.privacyGuard = token;
  script.onload = () => {
    script.remove();
    document.documentElement.removeAttribute("data-privacy-guard");
  };
  (document.head || document.documentElement).appendChild(script);
}

injectInline();
if (document.documentElement.getAttribute("data-privacy-guard") === token) {
  document.documentElement.removeAttribute("data-privacy-guard");
} else {
  // CSP da página bloqueou o script inline
  injectSrc();
}

// Interação real do usuário no documento principal: permite ao background
// distinguir navegação por clique de redirect automático por JavaScript
if (window === window.top) {
  let gestureSent = false;
  const onGesture = (event) => {
    if (!event.isTrusted || gestureSent) return;
    gestureSent = true;
    browser.runtime.sendMessage({ type: "userGesture" }).catch(() => {});
  };
  window.addEventListener("pointerdown", onGesture, true);
  window.addEventListener("keydown", onGesture, true);
}

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.__privacyGuard !== token) return;
  delete data.__privacyGuard;
  browser.runtime.sendMessage({ type: "pageEvent", event: data }).catch(() => {});
});
