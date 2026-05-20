# Venda no Zap Print Agent

Agente desktop (Electron, Windows) que roda na máquina do lojista, faz polling da fila de impressão da API do [Venda no Zap](https://vendanozap.app) e imprime os pedidos em impressora térmica ESC/POS (rede ou spooler Windows).

## Instalação

Baixe o instalador mais recente na página de [Releases](../../releases/latest) e execute. Não exige direitos de administrador.

Após instalar:

1. Abra o app — ele fica em bandeja
2. No painel admin da loja (vendanozap.app), gere um token de pareamento
3. Cole o token na janela do agente
4. Pronto — pedidos novos imprimem automaticamente

## Stack técnica

- Electron 31 + electron-vite + better-sqlite3 + `@thesusheer/electron-printer`
- TypeScript ~5.5, single-instance lock, bandeja sempre viva
- Persistência local: SQLite em `userData/agent.db` (WAL) + safeStorage (refresh token cifrado)
- Build: NSIS one-click installer (não exige UAC)

Mais detalhes técnicos no [CLAUDE.md](./CLAUDE.md).

## Desenvolvimento

```bash
npm install
npm run dev          # Electron dev (mock backend embutido, sem precisar API real)
npm run typecheck    # tsc node + web
npm run dist:win     # builda + empacota instalador (release/<version>/...exe)
```

Variáveis úteis (override defaults via env):

| Var | Default | Notas |
|---|---|---|
| `PRINT_AGENT_API_BASE_URL` | `https://api.vendanozap.app` | URL do backend |
| `PRINT_AGENT_USE_MOCK` | `true` (dev), `false` (packaged) | Mock backend embutido |
| `PRINT_AGENT_POLL_MS` | `5000` | Intervalo do polling da fila |
| `PRINT_AGENT_HEARTBEAT_MS` | `30000` | Intervalo do heartbeat |

## Release

1. Bump version em `package.json` (e em `electron-builder.yml` se necessário)
2. `npm run dist:win` → gera `.exe` em `release/<version>/`
3. `git tag v<version> && git push --tags`
4. Criar release no GitHub com o `.exe` anexado
5. Atualizar referência no painel admin se URL mudar (geralmente apontamos pra `latest/download`)

## Licença

Privado / Venda no Zap (Pedro Magno).
