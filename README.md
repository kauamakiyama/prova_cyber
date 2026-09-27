# Privacy Guard: extensão Firefox para detecção de rastreadores

Avaliação Intermediária de Cibersegurança (Insper). Extensão WebExtension (Manifest V2, JavaScript puro, sem build) que detecta e apresenta violações de privacidade no cliente web.

## Instalação (about:debugging)

1. Abra o Firefox e acesse `about:debugging#/runtime/this-firefox`.
2. Clique em **Carregar extensão temporária…**.
3. Selecione o arquivo `manifest.json` na raiz deste repositório.
4. Abra uma página e clique no ícone da extensão na barra de ferramentas.

> A extensão temporária é removida ao fechar o Firefox. Após alterar o código, clique em **Recarregar** no about:debugging.

## Estrutura

```
manifest.json    Declaração da extensão (MV2)
background.js    Monitoramento de rede (webRequest) e estado por aba
content.js       Ponte entre a página e o background (injeta o inject.js)
inject.js        Hooks de APIs executados no contexto da página
popup/           Interface: relatório por aba
docs/            Roteiro da avaliação
```

## Funcionalidades

### Detecção de terceira parte

O `background.js` escuta `webRequest.onBeforeRequest` para todas as URLs. Uma requisição é considerada de **terceira parte** quando o domínio registrável (eTLD+1) do host requisitado difere do eTLD+1 da página carregada na aba.

- O relatório da aba é zerado a cada nova navegação do frame principal (`type === "main_frame"`).
- Para cada domínio de 3ª parte registramos os hosts vistos, o total de requisições e a contagem por tipo (`script`, `image`, `xmlhttprequest`, `sub_frame`…).
- O badge do ícone mostra quantos domínios de 3ª parte distintos a página contatou.

**Limitação:** sem build não embutimos a Public Suffix List completa. Usamos uma lista reduzida de sufixos compostos (`com.br`, `co.uk`, `github.io`…); nos demais casos o eTLD+1 são os dois últimos rótulos. Domínios sob sufixos fora dessa lista podem ser agrupados incorretamente.

### Cookies injetados

O `background.js` escuta `webRequest.onHeadersReceived` (com `responseHeaders`) e interpreta cada cabeçalho `Set-Cookie` recebido pela aba, seguindo a RFC 6265. O Firefox entrega vários `Set-Cookie` de uma mesma resposta em um único valor separado por quebra de linha, que é dividido antes da análise.

Cada cookie é identificado por `nome|domínio|path`; se o mesmo cookie for definido mais de uma vez, vale a última definição.

| Classificação | Critério |
|---|---|
| **1ª parte** | eTLD+1 do domínio do cookie igual ao eTLD+1 da página |
| **3ª parte** | eTLD+1 do domínio do cookie diferente do da página |
| **Sessão** | sem `Max-Age` e sem `Expires`: some ao fechar o navegador |
| **Persistente** | `Max-Age` > 0 ou `Expires` no futuro (`Max-Age` tem precedência) |

- O domínio do cookie é o atributo `Domain`; na ausência dele, o host que respondeu.
- `Set-Cookie` com `Max-Age <= 0` ou `Expires` no passado é uma **exclusão** e não é contado.
- O popup mostra a matriz 1ª/3ª parte × sessão/persistente e a lista de cookies com expiração e atributos `Secure`, `HttpOnly` e `SameSite`.

**Limitações:**
- Cookies criados por JavaScript (`document.cookie`) não trafegam em cabeçalho HTTP e não são capturados por este mecanismo.
- A contagem é do que o servidor **tentou** definir. Com a Proteção Aprimorada contra Rastreamento do Firefox, requisições a rastreadores conhecidos podem ser bloqueadas antes da resposta, e cookies de 3ª parte são particionados por site (Total Cookie Protection).

### Armazenamento HTML5

Content scripts rodam em um "mundo isolado": veem o DOM da página, mas não os objetos JavaScript que os scripts do site usam. Para interceptar as chamadas reais, o `content.js` (rodando em `document_start`, em todos os frames) injeta o código do `inject.js` na página:

1. **Inline:** cria um `<script>` com o código da função; ele executa de forma síncrona, **antes** dos scripts do site.
2. **Fallback:** se a CSP da página bloquear scripts inline, injeta `<script src="moz-extension://…/inject.js">` (declarado em `web_accessible_resources`).

O `inject.js` se comunica com o `content.js` via `window.postMessage`, com um token aleatório por frame para descartar mensagens que não vieram do hook; o `content.js` repassa ao background com `runtime.sendMessage`.

Detecção feita no contexto da página:

| Mecanismo | O que captura |
|---|---|
| Hook em `Storage.prototype.setItem` | gravações em `localStorage`/`sessionStorage`: chave, tamanho do valor e URL do script que gravou (pilha de chamadas) |
| Hook em `IDBFactory.prototype.open` | abertura/criação de bancos IndexedDB e o script responsável |
| Retrato no `load` e 3 s depois | chaves de `localStorage`/`sessionStorage` e bancos (`indexedDB.databases()`); cobre gravações sem `setItem` (`localStorage.x = …`) e dados de visitas anteriores |

- Os dados são agrupados pela **origem do frame** que gravou; um iframe de outro eTLD+1 é classificado como **3ª parte**.
- Se o acesso ao storage lançar exceção (ex.: bloqueio de storage para 3ª parte), a origem aparece como "acesso bloqueado".
- O valor gravado não é armazenado pela extensão, apenas a chave e o tamanho.

**Limitações:**
- Um script que executar antes da injeção (ex.: `<script>` inline no `<head>` de um documento já em cache muito rápido) não é interceptado; o retrato posterior ainda registra as chaves que ele criou.
- A página pode detectar o hook (ex.: `Storage.prototype.setItem.toString()` não retorna `[native code]`).
