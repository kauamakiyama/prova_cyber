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

### Bounce tracking, parâmetros de rastreamento e cookie sync

**Cadeia de navegação.** O background mantém, por aba, a sequência de páginas pelas quais a navegação passou até a página atual. Uma página é considerada **salto intermediário** quando saiu por:

| Tipo de saída | Como é detectado |
|---|---|
| Redirect HTTP (301/302/303/307/308) | `webRequest.onBeforeRedirect` no `main_frame`; a próxima navegação para a URL de destino continua a cadeia |
| Redirect por JavaScript / meta refresh | a nova navegação tem `originUrl` igual à página anterior, a página anterior ficou aberta por ≤ 5 s **e** não houve interação do usuário nela (`pointerdown`/`keydown` confiáveis, capturados pelo `content.js` no documento principal) |

Redirects para o **mesmo host** (ex.: upgrade interno `http` → `https` do Firefox, que chega ao `onBeforeRedirect` com status 0) não viram salto: apenas atualizam a URL da página.

Para cada salto é registrado como ele saiu (status HTTP ou tempo de permanência) e os dados que tinha no navegador enquanto esteve aberto (nomes de cookies via `Set-Cookie` e chaves de localStorage/sessionStorage/IndexedDB, incluindo as já existentes de visitas anteriores).

**Bounce tracking.** Um salto intermediário é classificado como **bounce** quando seu eTLD+1 é diferente do eTLD+1 do destino final: o usuário "passou" por um site de terceiro, que teve acesso ao próprio storage de 1ª parte (onde pode ler/gravar um ID) sem que o usuário tivesse intenção de visitá-lo. Saltos dentro do mesmo site (ex.: `bad.third-party.site` → `good.third-party.site`) aparecem na cadeia, mas não são bounce.

A página de bounce costuma gravar o ID e redirecionar imediatamente, então a mensagem do content script pode chegar ao background depois que a próxima navegação começou. Eventos vindos do frame principal com host diferente da página atual são atribuídos ao salto correspondente da cadeia, e não ao storage da nova página.

**ID repassado pela URL.** Os valores gravados por cada salto intermediário (valores de `Set-Cookie` e de `setItem`, truncados em 256 caracteres) ficam só em memória no background. Se um parâmetro da URL de destino tiver valor idêntico a um deles, o popup mostra `parâmetro = valor de localStorage:chave gravado por host`. Isso identifica o ID contrabandeado pelo bounce independentemente do nome do parâmetro. Na página de teste do DDG, na primeira visita o ID vai em `isNew`, que não tem nome de identificador.

**Parâmetros na URL.** Os parâmetros da URL da página são classificados em:
- **rastreamento**: click IDs e marcação de campanha conhecidos (`gclid`, `fbclid`, `msclkid`, `fb_source`, `utm_*`, `_hs*`, `pk_*`, …);
- **identificador**: nome que sugere ID de usuário (`uid`, `uuid`, `guid`, `user_id`, `visitor_id`, `client_id`, `buyer_uid`…) ou valor com cara de ID (≥ 16 caracteres misturando letras e dígitos, ou número com ≥ 16 dígitos).

**Cookie sync.** Dois indícios, por página:

| Método | Critério |
|---|---|
| Valor de cookie na URL | um valor de cookie visto em `Set-Cookie` (com cara de identificador) aparece na URL (crua ou decodificada) de uma requisição a outro eTLD+1 |
| Redirect entre 3ª partes | subrecurso de um domínio de 3ª parte redirecionado para **outro** domínio de 3ª parte com parâmetro identificador na URL (padrão de pixel de sincronização) |

Valores de cookie são mantidos apenas em memória para essa comparação e não são exibidos. Números com até 15 dígitos (timestamps, cache busters) são ignorados para reduzir falsos positivos.

**Limitações:**
- O limite de 5 s é heurístico: uma página que redireciona por JavaScript depois de 5 s, ou depois de o usuário interagir com ela, não é tratada como salto.
- Só são comparados cookies definidos durante o carregamento da página atual; IDs gravados em visitas anteriores ou via `document.cookie` não entram na comparação de valores.
- Redirects de subrecurso entre 3ª partes **sem** parâmetro identificador não são sinalizados (o ID pode ir em cookie, invisível na URL).

### Canvas fingerprint

Canvas fingerprinting desenha texto e formas num `<canvas>` e lê os pixels resultantes: pequenas diferenças de fontes, antialiasing, GPU e driver fazem a imagem (e seu hash) variar entre dispositivos, mas se manter estável no mesmo dispositivo, sem precisar de cookies.

O `inject.js` acompanha, por canvas, o que foi desenhado e classifica cada extração da imagem:

| Hook | Função |
|---|---|
| `fillText` / `strokeText` (2D e OffscreenCanvas) | registra caracteres distintos e cores (`fillStyle`/`strokeStyle`) usadas no texto |
| `drawImage` + `OffscreenCanvas.transferToImageBitmap` | propaga o que foi desenhado de um canvas/bitmap para o canvas de destino |
| `getContext("webgl"/"webgl2")` | marca o canvas como WebGL |
| `toDataURL`, `toBlob`, `getImageData`, `OffscreenCanvas.convertToBlob`, `WebGL…readPixels` | **extração**: classifica e reporta |
| getters `contentWindow` / `contentDocument` de `HTMLIFrameElement`/`HTMLFrameElement` | instala todos os hooks na janela do iframe antes de devolvê-la à página |

**Canvas criado dentro de iframe.** Cada janela tem seus próprios protótipos; um canvas criado com `iframe.contentDocument.createElement("canvas")` usa o `HTMLCanvasElement.prototype` do iframe, que não passou pelos hooks da página. Scripts de fingerprint usam essa técnica para escapar de extensões (o BrowserLeaks faz exatamente isso). Por isso, quando a página acessa a janela ou o documento de um iframe da mesma origem, os hooks de storage, canvas e frames são instalados nela na hora. Iframes de outra origem não são acessíveis pela página e são cobertos pelo content script do próprio iframe.

**Critério** (adaptado de Englehardt & Narayanan, *Online Tracking: A 1-million-site Measurement and Analysis*, ACM CCS 2016). Uma extração é **fingerprint** quando:
1. a área extraída tem pelo menos **16×16 px**; e
2. o canvas contém texto com **≥ 10 caracteres distintos** ou **≥ 2 cores**, e a extração **não** usa formato com perda (`image/jpeg`, `image/webp`); **ou** o canvas é **WebGL** (a renderização depende de GPU/driver).

Extrações que não atendem ao critério aparecem como **leitura** (sem alerta): editores de imagem, compressão de fotos antes de upload, jogos.

- Cada canvas é reportado uma vez por método de extração (evita inundar o background com `getImageData` em loop de animação); o popup soma quantos canvases cada script extraiu.
- A classificação 1ª/3ª parte usa o domínio do **script** que extraiu a imagem (pilha de chamadas); se não houver URL na pilha, usa o frame.

**Limitações:**
- O critério original também exclui scripts que chamam `save`/`restore`/`addEventListener` no canvas (animações). Essa exclusão não foi implementada.
- Fingerprint só por `measureText` (medição de fontes) ou por WebGL sem extração de pixels (ex.: `getParameter` de `UNMASKED_RENDERER`) não é detectado.
- Scripts podem detectar os hooks e mudar de comportamento.
- Acesso a iframes por `window.frames[i]` / `window[i]` (sem passar por `contentWindow`) não instala os hooks na janela do iframe.

### Indicadores de hijacking e hook

Um script injetado na página (por XSS, por um terceiro comprometido ou por um framework como o BeEF) costuma deixar dois tipos de rastro: **um canal persistente com um servidor de terceiros**, por onde recebe comandos e envia dados, e **alterações no ambiente JavaScript da página** para interceptar tráfego e eventos.

**Na rede (`background.js`):**

| Indicador | Critério |
|---|---|
| WebSocket para 3ª parte | requisição `webRequest` do tipo `websocket` para eTLD+1 diferente da página |
| Polling persistente para 3ª parte | o mesmo endpoint de 3ª parte (host + caminho, sem query; tipos `xmlhttprequest`, `beacon`, `ping`, `image`, `script`, `other`) chamado em **≥ 4 rodadas** ao longo de **≥ 20 s**. Requisições a menos de 2 s umas das outras contam como a mesma rodada: um leilão de anúncios dispara várias de uma vez, e o que caracteriza o canal persistente é a rodada se repetir. O popup mostra o intervalo típico (mediana) entre rodadas |

**No contexto da página (`inject.js`, só no documento principal):** no `document_start`, antes de qualquer script do site (e depois dos hooks da própria extensão), são guardados:
- o conjunto de propriedades próprias de `window` (`Object.getOwnPropertyNames`);
- as referências de funções nativas usadas para interceptar tráfego, eventos e DOM: `fetch`, `XMLHttpRequest` (+ `open`, `send`, `setRequestHeader`), `WebSocket`, `EventSource`, `navigator.sendBeacon`, `EventTarget.addEventListener`, `document.write`, `document.createElement`, `Node.appendChild`/`insertBefore`, `history.pushState`/`replaceState`, `window.open`, `eval`, `setTimeout`/`setInterval`, `postMessage`, `Function.prototype.toString`, `JSON.stringify`/`parse`.

O diff é feito 3 s, 10 s e 30 s após o `DOMContentLoaded` (não o `load`, que em portais com muitos anúncios demora demais), depois a cada 60 s e **sempre que o popup é aberto**: o background pede ao `content.js` do documento principal uma verificação imediata e espera 300 ms pela resposta antes de montar o relatório.

| Indicador | Critério |
|---|---|
| Função nativa sobrescrita | a referência atual difere da guardada no início. Quando a função substituta tem a marca que a biblioteca deixa apontando para a original, o autor provável é indicado: `__sentry_original__` (Sentry), `__zone_symbol__OriginalDelegate` (zone.js/Angular), `__rrweb_original__` (rrweb, session replay) |
| Global adicionada | propriedade nova em `window` que não é função nativa do navegador (APIs resolvidas sob demanda são ignoradas) nem índice numérico (`window[0]`… são os iframes da página); globais de bibliotecas conhecidas são identificadas (`dataLayer` = Google Tag Manager, `fbq` = Meta Pixel, `pbjs` = Prebid.js, `hj` = Hotjar…) |
| Assinatura do BeEF | global `beef` / `BeefJS` / `beef_init` ou `<script src=".../hook.js">` |

A extensão usa cópias de `postMessage` e `Function.prototype.toString` guardadas no início, de modo que um script que as sobrescreva não consegue silenciar o relatório.

**Pegada da própria extensão:** a extensão não substitui construtores globais (`WebSocket`, `fetch`…) justamente para não alterar o ambiente que ela mesma avalia. Os hooks de storage e canvas alteram métodos de protótipos (`Storage.prototype.setItem`, `IDBFactory.prototype.open`, `HTMLCanvasElement.prototype.toDataURL`…), o que é visível para uma página que inspecione esses métodos (ex.: página js-leaks do DDG).

**Limitações:**
- Globais adicionadas são comuns em sites legítimos (bibliotecas, analytics); o número sozinho não indica ataque. O que pesa são funções nativas sobrescritas, canais persistentes com terceiros e assinaturas conhecidas.
- Polling com intervalo maior que o período observado, ou que muda de caminho a cada chamada, não é agrupado.
- Uma função nativa sobrescrita e depois restaurada entre duas verificações não é detectada.

### Lista de bloqueio personalizada

O usuário mantém uma lista de domínios bloqueados, salva em `browser.storage.local` (chave `blocklist`), que persiste entre sessões e sobrevive a recarregar a extensão.

**No popup:**
- seção **Lista de bloqueio**: campo para adicionar um domínio e botão **Remover** em cada entrada. A entrada é normalizada: aceita `doubleclick.net`, `*.doubleclick.net`, `https://ads.exemplo.com/caminho` (vira `ads.exemplo.com`) ou IPv4; entradas inválidas são recusadas;
- botão **Bloquear** ao lado de cada domínio da seção "Domínios de terceira parte" (adiciona o eTLD+1);
- seção **Bloqueados nesta página**: regras que bloquearam algo nesta aba, com hosts, contagem e tipos de requisição;
- depois de alterar a lista, o popup oferece **Recarregar página** (o que já carregou continua na página).

**No background:**
- a lista é carregada na inicialização e atualizada por `storage.onChanged`, sem precisar recarregar a extensão;
- `webRequest.onBeforeRequest` com `["blocking"]` (permissão `webRequestBlocking`) retorna `{ cancel: true }` quando o host da requisição **é o domínio da lista ou um subdomínio dele** (`host === d || host.endsWith("." + d)`). `doubleclick.net` bloqueia `securepubads.g.doubleclick.net`, mas não `notdoubleclick.net`;
- vale para todos os tipos de requisição, inclusive `websocket`, e também para requisições **sem aba** (`tabId -1`, ex.: feitas por service workers);
- a navegação principal (`main_frame`) **não** é bloqueada: a lista age sobre os recursos que as páginas carregam;
- requisição bloqueada não chega a conectar, então entra só em "Bloqueados nesta página", e não nas estatísticas de 3ª parte, cookies etc.

**Teste de referência:** a página *Request Blocking* do DDG (`/privacy-protections/request-blocking/`) pede explicitamente para adicionar `bad.third-party.site` à lista de bloqueio e testa 23 mecanismos de requisição (img, script, fetch, XHR, WebSocket, sendBeacon, iframes, workers, CSS, favicon…).

**Limitações:**
- Bloqueio só por domínio (sem caminhos nem expressões como nas listas do uBlock Origin/EasyList).
- Requisições que o Firefox não expõe ao `webRequest` de extensões (ex.: algumas cargas internas do navegador) não podem ser bloqueadas.

## Score de privacidade

O popup mostra, no topo, uma nota de **0 a 100** para a página atual, com a classificação e a perda em cada critério. A nota é recalculada toda vez que o popup é aberto, a partir do que as detecções acima registraram na aba.

### Metodologia

A página **começa com 100 pontos** e perde pontos em **7 critérios**. Cada critério tem um **peso**, que é a perda máxima possível nele; os pesos somam 100. Dentro do peso, a perda cresce com a quantidade observada.

| # | Critério | Peso | Perda | Justificativa |
|---|---|---|---|---|
| 1 | Domínios de 3ª parte | 20 | 1 por domínio (eTLD+1) contatado | Cada terceiro recebe, em toda requisição, IP, User-Agent e `Referer` (a página que o usuário está lendo). É a base de qualquer rastreamento entre sites. |
| 2 | Cookies de 3ª parte | 20 | 2 por cookie **persistente**, 1 por cookie **de sessão** | Principal mecanismo de identificação entre sites. O persistente pesa o dobro porque sobrevive ao fechamento do navegador e permite reconhecer o usuário semanas depois. |
| 3 | Cookie sync, bounce e IDs na URL | 15 | 5 por sincronização de cookie, por salto de bounce e por ID repassado; 3 por identificador na URL; 2 por parâmetro de rastreamento (`gclid`, `utm_*`…) | Técnicas que **ligam identidades** entre domínios e contornam o isolamento de cookies do navegador (Total Cookie Protection). |
| 4 | Canvas fingerprint | 15 | 15 se extraído por script de **3ª parte**; 10 se de 1ª parte | Identifica o dispositivo sem cookie, sem consentimento e sem que o usuário consiga apagar. Por 3ª parte, o mesmo identificador vale em todos os sites onde o script está. |
| 5 | Session replay e pixels | 10 | 5 por ferramenta de session replay (Microsoft Clarity, Hotjar, FullStory); 3 por pixel de rede social/anúncio (Meta, TikTok, LinkedIn, Microsoft UET). Contagem por **fornecedor**: `fbq` e `_fbq` são o mesmo Meta Pixel | Session replay grava cliques, rolagem e digitação; pixels enviam a navegação para a plataforma de anúncio. Correspondem aos testes *session recording* e *Facebook pixel* do Blacklight. |
| 6 | Hijacking/hook | 10 | 4 por WebSocket de 3ª parte; 2 por polling persistente; 2 por função nativa sobrescrita sem autor conhecido; 0,5 por função sobrescrita por biblioteca conhecida (Sentry etc.) | Canais persistentes com terceiros e interceptação de APIs são o que um script injetado precisa para receber comandos e ler o tráfego da página. |
| 7 | Armazenamento de 3ª parte | 10 | 2 por chave de 3ª parte (localStorage, sessionStorage, IndexedDB); 1 a cada 20 chaves de 1ª parte | Storage de 3ª parte guarda identificadores fora do alcance da limpeza de cookies. O de 1ª parte pesa pouco: normalmente são preferências e estado do próprio site. |

**Regra especial: BeEF.** Se a assinatura do BeEF é detectada, o score fica **limitado a 20**, independentemente dos outros critérios. Framework de exploração ativo significa navegador comprometido, e não só rastreado.

**Classificação:**

| Score | Classificação |
|---|---|
| 85 a 100 | **Boa** |
| 65 a 84 | **Moderada** |
| 40 a 64 | **Ruim** |
| 0 a 39 | **Crítica** |

As faixas foram calibradas nos testes: uma página de teste com **um único** comportamento isolado (ex.: canvas fingerprint de 1ª parte, 90) fica em "Boa"; um site com uma dúzia de rastreadores e alguns cookies de 3ª parte cai para "Moderada"; um portal com leilão de anúncios (dezenas de domínios, cookies e sincronizações) fica em "Crítica".

**Requisições bloqueadas** pela lista personalizada não contam: elas não chegaram a acontecer. Bloquear rastreadores melhora a nota da página.

### Relação com o Blacklight

O Blacklight (The Markup) roda 7 testes e reporta cada um como presente/ausente, sem nota numérica: rastreadores de anúncio, cookies de 3ª parte, canvas fingerprinting, session recording, key logging, Facebook pixel e Google Analytics "remarketing audiences". O score cobre diretamente 4 deles (rastreadores de 3ª parte, cookies de 3ª parte, canvas fingerprinting, session recording + Meta Pixel) e acrescenta o que o Blacklight não mede: cookie sync/bounce, storage de 3ª parte e indicadores de hijacking.

**Limitações:**
- Os pesos são uma escolha de projeto, justificada acima, e não uma medida absoluta de risco.
- "Domínios de 3ª parte" usa eTLD+1: domínios do próprio grupo do site (ex.: `glbimg.com` no `globo.com`) contam como 3ª parte.
- Key logging não é detectado diretamente; aparece de forma indireta quando uma ferramenta de session replay é identificada.
- O critério 5 depende das globais da página. Até a primeira verificação (poucos segundos após o `DOMContentLoaded`), o popup marca o score como **parcial**.
