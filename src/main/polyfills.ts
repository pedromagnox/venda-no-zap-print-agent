// Build legado (Windows 7/8/8.1): Electron 22 = Node 16.17, que NÃO tem
// `fetch`, `Headers`, `Request` nem `Response` globais — o client da API
// (`lib/api/client.ts`) usa os quatro. Sem isto o app abre e falha na primeira
// chamada ao servidor, ou seja, ao conectar a loja.
//
// O undici 5 é a MESMA implementação que o Node 18 expõe como fetch nativo,
// então o comportamento (e o formato dos erros, que o enrichFetchError lê em
// `err.cause`) é idêntico ao do build principal em Electron 31.
//
// Só instala o que faltar: se um dia este código rodar num Node com fetch
// nativo, nada é sobrescrito.
import { fetch, FormData, Headers, Request, Response } from 'undici'

const g = globalThis as unknown as Record<string, unknown>
if (typeof g['fetch'] !== 'function') {
  g['fetch'] = fetch
  g['Headers'] = Headers
  g['Request'] = Request
  g['Response'] = Response
  g['FormData'] = FormData
}
