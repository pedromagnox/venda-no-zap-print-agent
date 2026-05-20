// Servidor TCP simulando uma impressora térmica na porta 9100.
// Imprime no terminal qualquer byte recebido (controlchars viram '·').
// Uso: `npm run fake-printer [porta]`.

import { createServer } from 'node:net'

const port = Number(process.argv[2] ?? 9100)

const server = createServer((socket) => {
  const remote = `${socket.remoteAddress}:${socket.remotePort}`
  console.log(`\n[fake-printer] >>> connection from ${remote}`)
  let total = 0
  socket.on('data', (data) => {
    total += data.length
    // Replace control chars (exceto LF) por · pra ficar legível
    const readable = data
      .toString('latin1')
      .replace(/[\x00-\x09\x0B-\x1F]/g, (c) => `·`)
    process.stdout.write(readable)
  })
  socket.on('end', () => {
    console.log(`\n[fake-printer] <<< closed, ${total} bytes total\n`)
  })
  socket.on('error', (err) => {
    console.error('[fake-printer] socket error:', err.message)
  })
})

server.on('error', (err) => {
  console.error('[fake-printer] server error:', err)
  process.exit(1)
})

server.listen(port, '0.0.0.0', () => {
  console.log(`[fake-printer] listening on 0.0.0.0:${port}  (Ctrl+C para parar)`)
  console.log('[fake-printer] aponte o Print Agent pra 127.0.0.1:' + port)
})
