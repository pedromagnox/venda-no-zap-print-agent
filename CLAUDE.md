# Venda no Zap Print Agent

Agente desktop (Electron, Windows-first) que roda na máquina do lojista, faz polling da fila de impressão da API do Venda no Zap e imprime os pedidos em impressora térmica ESC/POS (rede ou spooler do Windows). Roda em bandeja, com auto-start, fila local resiliente e telemetria.

> Projeto irmão da API/SPA do [Venda no Zap](../Venda-no-Zap/CLAUDE.md). O agente é um cliente puro — toda a fonte da verdade fica no backend.

## Stack

- **Runtime**: Electron 31 (Node embarcado), single-instance, bandeja sempre viva
- **Build**: electron-vite + electron-builder (NSIS one-click pra Windows x64)
- **Renderer**: React 18 + Vite (UI compacta, janela fixa 420×620, não-resizable)
- **Persistência local**: better-sqlite3 (WAL) em `userData/agent.db` + safeStorage (refresh token cifrado)
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
3. **Auth**: se há refresh token em safeStorage → tenta `POST /api/print-agent/ping`. Se ok, vira **verde**.
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
