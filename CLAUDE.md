# Venda no Zap Print Agent

Agente desktop (Electron, Windows-first) que roda na máquina do lojista, faz polling da fila de impressão da API do Venda no Zap e imprime os pedidos em impressora térmica ESC/POS (rede ou spooler do Windows). Roda em bandeja, com auto-start, fila local resiliente e telemetria.

> Projeto irmão da API/SPA do [Venda no Zap](../Venda-no-Zap/CLAUDE.md). O agente é um cliente puro — toda a fonte da verdade fica no backend.

## Stack

- **Runtime**: Electron 31 (Node embarcado), single-instance, bandeja sempre viva
- **Build**: electron-vite + electron-builder (NSIS one-click pra Windows x64)
- **Renderer**: React 18 + Vite (UI compacta, janela 420×620 — menos em tela baixa —, não-resizable)
- **Persistência local**: better-sqlite3 (WAL) em `userData/agent.db` + safeStorage (lista de lojas cifrada)
- **Impressão**: `@thesusheer/electron-printer` (spooler Windows) + socket TCP 9100 (rede)
- **Sem auto-update**: lojista baixa o `.exe` novo e instala por cima.

## Layout

```
src/
  main/           # Processo Electron principal
    index.ts        # bootstrap, single-instance, lifecycle
    ipc.ts          # Handlers IPC (connect, test print, set printer, etc.)
    tray.ts         # Bandeja + ícones de status (verde/amarelo/vermelho)
    agentState.ts   # Estado central (EventEmitter) sincronizado com a UI
    autoStart.ts    # Registro de auto-start no Windows
  preload/        # Bridge contextBridge (única superfície main↔renderer)
  renderer/       # React (Connection/Printer/Preferences/History/Logs)
  shared/         # Tipos compartilhados entre processos
  lib/
    api/            # client.ts (fetch + refresh), endpoints.ts, mock-backend.ts, types.ts
    auth/           # tokenManager.ts (refresh em memória), device.ts (fingerprint)
    queue/          # queueLoop.ts (claim/print/ack), localQueue.ts (sqlite), paperWidth.ts
    printer/        # makePrinter, NetworkPrinter, WindowsSpoolerPrinter, escpos-test
    storage/        # db.ts (sqlite + recovery), jsonStore.ts, safeStorage.ts
    telemetry/      # buffer.ts (sqlite), service.ts, heartbeat.ts, sanitize.ts
    logs/           # logsStore.ts (sqlite, retenção 48h)
    config.ts       # Config via env (apiBaseUrl, useMock, intervalos)
scripts/          # generate-tray-icons.mjs, fake-printer.mjs
build/            # icon.png (master), icons/tray-*.png
```

## Comandos

Usa **npm** (não pnpm). Existe `package-lock.json`.

```bash
npm install
npm run dev               # electron-vite dev — abre janela + mock backend (porta 4317)
npm run typecheck         # node + web (tsc -p separados)
npm run electron:rebuild  # rebuild de better-sqlite3 contra o Electron — rodar ao trocar major do Electron
npm run dist:win          # builda + empacota NSIS (release/<version>/...exe)
npm run icons             # regenera build/icons/tray-*.png a partir do build/icon.png
npm run fake-printer      # sobe printer ESC/POS fake em TCP local pra teste
```

`npmRebuild: false` no `electron-builder.yml` — não tenta recompilar native modules durante `dist`. Se isso quebrar (por trocar major do Electron), rode `electron:rebuild` antes.

## Como o agente funciona (fluxo)

1. **Boot**: requisita single-instance lock; se já tem outra instância, manda foco e sai.
2. **DB**: abre `agent.db` com recovery automática (renomeia `.corrupt.<ts>` se WAL/SHM estiver corrompido por kill abrupto).
3. **Auth**: lê a lista de lojas do safeStorage (`accounts`) e conecta **cada uma**. Se ok, vira **verde**.
4. **Polling**: `QueueLoop` faz `GET /api/print-queue` a cada `pollIntervalMs` (default 5s).
5. **Imprimir um item**:
   - `POST /api/print-queue/:id/claim` → recebe `payload.bytes` (base64) + `paperWidth` + `leaseExpiresAt`.
   - Persiste no `localQueue` (sqlite) **antes** de imprimir — se o app crashar entre claim e ack, faz `recoverLocal()` no próximo boot.
   - Imprime via `makePrinter(config)` → ESC/POS.
   - Sucesso → `POST /ack`. Falha → `POST /release` com `errorCode`/`hint`.
6. **Heartbeat**: a cada `heartbeatIntervalMs` (default 30s), envia `POST /api/print-agent/ping` e drena telemetria/logs.
7. **Bandeja**: status (green/yellow/red) reflete último resultado. Fechar a janela só esconde — agente continua na bandeja.

## Backend ao qual ele conversa

API do Venda no Zap hospedada em **Fly.io (`gru`)** em `https://api.vendanozap.app` desde mai/2026.

> **Installers ≤ v0.2.x** foram lançados com default `https://vendanozap.app` (era a mesma origem do api Express no Replit). Após o cutover pra Cloudflare Workers, `vendanozap.app` deixou de servir `/api/*`. O Worker faz **proxy reverso transparente** de `/api/print-queue/*` e `/api/print-agent/*` pra `api.vendanozap.app` como safety net, então essas instalações continuam funcionando. Novos builds (v0.3.0+) batem direto no subdomínio API.

Rotas em [`artifacts/api-server/src/routes/print-agent.ts`](../Venda-no-Zap/artifacts/api-server/src/routes/print-agent.ts) e [`print-queue.ts`](../Venda-no-Zap/artifacts/api-server/src/routes/print-queue.ts). Endpoints usados:

- `POST /api/print-agent/token/exchange` — troca refresh por access token
- `POST /api/print-agent/ping` — health/registro de presença
- `POST /api/print-agent/telemetry` — eventos (agent_started, printer_state_change, agent_crashed, ...)
- `GET /api/print-queue` — lista itens pendentes (tolerante a envelope `{items}` ou array direto, e a `orderId`/`orderNumber`)
- `POST /api/print-queue/:id/claim` — reserva item (com lease)
- `POST /api/print-queue/:id/ack` — confirma impressão
- `POST /api/print-queue/:id/release` — devolve à fila (com erro)

`endpoints.ts` é **deliberadamente tolerante** a diferenças de naming entre versões do backend (`orderId` vs `orderNumber`, envelope vs array). Manter essa tolerância em mudanças novas.

## Config (env vars)

| Var | Default packaged | Default dev | Notas |
|---|---|---|---|
| `PRINT_AGENT_API_BASE_URL` | `https://api.vendanozap.app` (v0.3.0+); `https://vendanozap.app` (≤v0.2.x, funciona via Worker proxy) | mock `http://127.0.0.1:4317` ou `http://localhost:3000` | URL do backend |
| `PRINT_AGENT_USE_MOCK` | `false` (forçado) | `true` | Mock só roda em dev |
| `PRINT_AGENT_MOCK_PORT` | — | `4317` | Porta do mock embutido |
| `PRINT_AGENT_POLL_MS` | `5000` | `5000` | Intervalo do queue loop |
| `PRINT_AGENT_HEARTBEAT_MS` | `30000` | `30000` | Intervalo do heartbeat |

Dotenv não é carregado automaticamente; setar via `--env-file=.env` ou ambiente.

## Multi-loja (v1.11.0)

Uma instalação atende **N lojas** — o caso do lojista com duas lojas e uma impressora só.

- **Por loja** (`main/storeConnection.ts`): token, endpoints, telemetria, heartbeat, fila e WebSocket. `index.ts` guarda um `Map<storeId, StoreConnection>`.
- **Da máquina** (um só): impressora, preferências, `agent.db`, logs, bandeja.
- **`printerMutex`** serializa o papel entre as lojas — a impressora é uma só e dois cupons entrelaçados sairiam embaralhados. Vale também pros testes do wizard.
- **`claimed_items` e `telemetry_buffer` têm `store_id`**. Sem isso o ack iria pro endpoint da loja errada e a telemetria seria atribuída a quem drenasse primeiro. `store_id NULL` = linha de antes da atualização; a **primeira** loja da lista as adota (`adoptsLegacyRows`).
- **Estado**: `snapshot.stores[]` tem uma entrada por loja; `connection` espelha a primeira (é o que o gate de onboarding usa). A bandeja mostra o **pior** status. Cada loop escreve via `state.scopedFor(storeId)` — sem isso o `setStatus` de uma loja apagaria o da outra.
- **Servidor**: a PK de `print_agent_devices` é **(store_id, device_id)** desde 20/09/2026. Era só `device_id` (derivado da máquina), então a mesma máquina em duas lojas tinha uma linha que pulava de loja a cada refresh.
- Colar o token de uma loja **já conectada** atualiza aquela entrada em vez de criar outra — senão dois loops claimariam o mesmo pedido.
- ⚠️ **A `StoreConnection` nasce com `storeId` vazio** (só descobre a loja no primeiro exchange). Tudo que depende da loja recebe um GETTER (`lojaAtual()`), nunca o id copiado: até a 1.11.1 a visão do estado, a fila local e o buffer de telemetria guardavam `''`, e o status de erro da fila se perdia (o app dizia "Tudo certo" falhando). Linhas sqlite com `store_id = ''` são adotadas pela primeira loja, como as `NULL`.

## Sem impressora escolhida (v1.11.2)

- O `QueueLoop` **não pega pedido** sem alvo (`hasPrinterTarget`): fica amarelo "Escolha a impressora…" e os pedidos esperam na fila. Antes pegava, falhava com INVALID_CONFIG e gastava 1 das 3 tentativas (Oxe: 10 dias; Renascer: roubava o pedido do Android).
- O ping manda `printerConfigured` → o painel avisa "aberto, mas sem impressora escolhida".
- Ao escolher a impressora, `kick()` com **espera de 3 s**: o wizard chama `setPrinter` a cada tecla do IP, e um kick por tecla imprimiria em "192.1".
- Porta **COM não é "suspeita"** (Bluetooth pareado e serial são legítimos); só LPT.
- Janela com altura `min(620, área útil da tela)`: em tela pequena o rodapé e o "Enviar logs" sumiam.

## Reconexão do boot, vigia e consulta de segurança (v1.11.3)

- **Boot sem internet** (`index.ts`, `reconectarSalva`): a reconexão de cada loja salva repete com espera crescente (5 s, 10 s, 20 s… até 60 s) até conectar, e o `agent_started` sai quando conecta. Antes era uma tentativa só: o app abre com o Windows antes do Wi-Fi e ficava vermelho até reinstalar (Oxe, #206). Token recusado (401) não se repete.
- **Consulta de segurança**: com o WebSocket conectado (paused), o `QueueLoop` consulta a fila a cada 75 s (`PAUSED_SAFETY_POLL_MS`). Antes o paused só andava com a campainha: app vivo que perdia o aviso ficava parado até reabrir (Five Smash). O log «Consulta de segurança: N pedido(s) na fila sem aviso do servidor» = campainha perdida.
- **Vigia** (`StoreConnection.vigiar`, a cada ping que deu certo): religa a busca, como o pós-resume, quando ela está suspensa há mais de 1 min sem o `resume`/`unlock-screen` do Windows, ou ativa e sem tick há mais de 4 min. O `suspend()` não para o heartbeat justamente para isso.
- `resumeAfterWake()` não reinicia o loop com tick ou `recoverLocal` em andamento (`isBusy`): o `recoverLocal` releria a fila local e imprimiria de novo o pedido que ainda está saindo.
- **v1.11.4** (casos que a 1.11.3 deixava passar, apontados pela sessão Atendente em 16/10):
  - o vigia também religa a busca **inativa e ociosa fora da suspensão**. Com a reimpressão das pendentes em andamento, o pós-resume pulava o reinício e o loop, parado pela suspensão, morria;
  - o `recoverLocal` confere, já com a vez na impressora, se o pedido ainda está na fila local (`localQueue.has`). Um tick de antes da suspensão podia tê-lo impresso, e saía em dobro;
  - WebSocket com `handshakeTimeout` de 15 s. Sem prazo, um handshake que nunca respondia deixava o WS em «conectando» para sempre.
  - Teste: `scripts/teste-real-reimpressao.mjs`.
- Teste de verdade dos três casos: `scripts/teste-real.mjs` (Electron em xvfb contra servidor falso, «internet» desligada no boot, campainha muda, `powerMonitor.emit('suspend')` pelo inspector do main; `--contraste` roda a versão velha). Pré-requisitos no cabeçalho do script.

## Impressora sem fila: o app cria (v1.12.0)

- `lib/printer/semFila.ts` acha a térmica que o Windows enxerga mas ainda não tem impressora (fila): **Bluetooth pareada** (porta COM de **saída** do SPP) e **USB sem driver** (porta USB00x do usbprint, ligada agora). Fica na tela da impressora, em «Encontradas neste computador», e atualiza sozinha a cada 5 s.
- «Usar esta» cria a fila **Generic / Text Only** na porta (`rundll32 printui.dll,PrintUIEntry /if … /f ntprint.inf /u /q`), primeiro sem pedir nada e, se o Windows não deixar, com a janela de permissão (UAC, `Start-Process -Verb RunAs`). Quem decide se deu certo é o registro (`…\Control\Print\Printers\<nome>`).
- A impressão **continua pela fila do Windows**: a térmica segue dividida com iFood e outros programas. Imprimir direto na porta foi descartado por isso.
- Tudo pelo `reg query`, **sem PowerShell** (que não responde nos PCs fracos). Chaves: `Enum\BTHENUM` (PortName; saída = instância com o endereço do aparelho, entrada = 000000000000), `Services\BTHPORT\Parameters\Devices\<mac>` (Name em REG_BINARY UTF-8), `Control\DeviceClasses\{28d78fad-…}` (`#\Device Parameters`: Base Name + Port Number; `#\Control` Linked = 1 = ligada), `Control\Print\Printers` (Port).
- USB de marca com driver próprio (Elgin, Bematech, Epson…) mostra o aviso para instalar o driver de quem também imprime por outro programa (99Food em modo gráfico precisa dele).
- A v1.6–1.8 tinha um auto-instalador só de USB pelo PowerShell, aposentado na 1.10.5 junto com o YICHIP. Na época a fila Generic deixava a loja em modo pobre (sem corte, sem acento); desde a 1.10.4 o app manda RAW no modo do assistente, e isso deixou de valer.
- Testes: `node --test scripts/teste-sem-fila.mjs` (saídas do `reg query` em pt-BR). Tela: `scripts/foto-sem-fila.mjs` (lista falsa com `PRINT_AGENT_FAKE_SEM_FILA=1`, que só vale fora do Windows).
- Cada busca que muda deixa uma linha «Busca de impressoras: …» no log (portas Bluetooth de saída, pareadas, portas USB, filas, sem fila). Ela vai junto no «Enviar logs ao suporte»: é por ela que se vê, de longe, onde a impressora sumiu.
- ⚠️ Os formatos do registro e o `printui` com `ntprint.inf` só se provam num Windows de verdade.
- O assistente de modo ganhou «Agora não — ver a tela principal» (`onSkip`). Até a 1.11.4 ele era uma trava: sem modo salvo, a tela principal só abria depois de salvar um, e o teste depende do servidor. App sem conexão ficava preso no «Não saiu nada?» sem ver o status (Magrello Burger, #828). Os pedidos saem mesmo assim no modo derivado; o assistente volta na próxima abertura.

## Microsoft Store (MSIX)

- Build separado do .exe: `npm run dist:store` (`electron-builder.store.yml`, que estende o `electron-builder.yml` e troca o alvo por `appx`). Só roda no Windows (makeappx), então sai do workflow `.github/workflows/store.yml` (runner `windows-latest`), disparado por push no ramo `feat/store` ou à mão. O pacote fica no artefato `msix-store`.
- Identidade da Store (Partner Center): `VendanoZap.VendanoZapImpresso`, publisher `CN=01F755B9-38FC-4815-990B-0E26A4D36EAA`, nome de família `VendanoZap.VendanoZapImpresso_6h62scjbd05x8`, Store ID `9NP27QFD67Q4`. O `displayName` tem que ser igual ao nome reservado («Venda no Zap Impressão»).
- O pacote vai sem assinatura: a Store assina depois da certificação. Para teste local, só com certificado de teste cujo Subject seja o publisher, e esse certificado nunca entra no repositório.
- Versão = a do `package.json` + `.0` (ex.: 1.12.0.0). A Store recusa revisão ≠ 0, e cada envio precisa de uma versão maior que a anterior.
- Iniciar com o Windows: `StartupTask` (`addAutoLaunchExtension`). No pacote, `process.windowsStore` é true: o `applyAutoStart` não grava no registro, e o app abre só na bandeja se o Windows ligou há menos de 5 min (o StartupTask não passa `--hidden`). Com Inicialização Rápida, o tempo ligado não zera, e a janela pode aparecer.
- O ping manda `canal: 'store' | 'exe'`.
- Tiles em `build/appx/`, gerados do `build/icon.png` (fundo #F46A25).
- Dados: tudo em `app.getPath('userData')`. A pasta do app no pacote é só leitura.

## Convenções e armadilhas

- **Native modules ficam fora do asar** (`asarUnpack` no `electron-builder.yml`). Ao adicionar outro `.node`, repetir o padrão.
- **Path com espaço**: o repo está em `OneDrive/Venda no Zap/...`. Sem `npmRebuild: false`, o build tenta recompilar e falha. Não confiar em `node-gyp` na máquina do lojista — sempre depender de prebuilds.
- **DevTools só em dev**: `webPreferences.devTools = !app.isPackaged`. Não habilitar em produção (lojista não-técnico).
- **`pushLog` é a única forma de log estruturado**: vai pra UI + sqlite (retenção 48h). Não usar `console.log` em código de produção (sobra como ruído no .log do Electron).
- **Telemetria sanitizada**: passar mensagens por `sanitize()` antes de enviar — não vazar PII, tokens, ou IPs internos do lojista.
- **Refresh token revogado** (`refresh-rejected`): o agente **não** tenta reauth sozinho; para tudo e instrui o lojista a colar novo token. Manter esse comportamento.
- **Lease + crash safety**: SEMPRE persistir no `localQueue` **antes** de imprimir. Sem isso, um crash entre claim e ack imprime duas vezes na próxima execução.
- **Best-effort release no quit**: `before-quit` tenta soltar claim em vôo em até 2s — não bloquear o shutdown além disso.
- **Single instance**: garantido por `requestSingleInstanceLock`. Segundo lançamento foca a janela existente.
- **Auto-start**: gerenciado por `applyAutoStart` (registro do Windows). Em dev é no-op. App lançado pelo Windows com `--hidden` não mostra janela — só sobe na bandeja.
- **Sem auto-update**: `publish: null`. Atualização = lojista baixa novo `.exe`, NSIS one-click instala por cima.
- **Ícones da bandeja**: gerados por `scripts/generate-tray-icons.mjs` a partir do `build/icon.png`. Empacotados via `extraResources` (não asar).

## Quando assinar o binário

Hoje está unsigned (causa o aviso do SmartScreen). Quando for assinar:
- **Azure Trusted Signing**: adicionar `azureSignOptions:` no `win:` do `electron-builder.yml`.
- **Cert tradicional**: `certificateFile` + `certificatePassword`.

Nada mais muda no build.

## Estilo de trabalho

- Não introduzir dependência nova sem alinhamento (toda dep vira peso no instalador e risco de prebuild faltando).
- Mudanças no fluxo de auth ou queue: **manter compat retroativa** com o backend atual (`endpoints.ts` é o ponto de absorção).
- Erros do usuário (impressora offline, sem driver, etc.) devem virar `hint` claro em PT-BR — o lojista resolve sozinho (ver `buildErrorHint` em `ipc.ts`).
- Toda persistência nova vai pro `agent.db` (não criar novos arquivos em userData sem motivo) e precisa de retenção/prune.
