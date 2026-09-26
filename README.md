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
