const net = require('net');

const LISTEN_HOST = process.env.CODEX_TLS_ROUTER_HOST || '0.0.0.0';
const LISTEN_PORT = Number(process.env.CODEX_TLS_ROUTER_PORT || 443);
const CODEX_PORT = Number(process.env.CODEX_TLS_ROUTER_CODEX_PORT || 8443);
const XRAY_PORT = Number(process.env.CODEX_TLS_ROUTER_XRAY_PORT || 9443);
const CODEX_HOSTS = new Set(['codex4web.me', 'codex.internal']);

function readServerName(buffer) {
  if (buffer.length < 5 || buffer[0] !== 0x16) return null;
  const recordLength = buffer.readUInt16BE(3);
  if (buffer.length < 5 + recordLength) return undefined;
  if (buffer[5] !== 0x01 || buffer.length < 9) return null;
  const helloLength = buffer.readUIntBE(6, 3);
  if (buffer.length < 9 + helloLength) return undefined;

  let offset = 9;
  if (offset + 2 + 32 + 1 > buffer.length) return null;
  offset += 2 + 32;
  const sessionLength = buffer[offset];
  offset += 1 + sessionLength;
  if (offset + 2 > buffer.length) return null;
  const cipherLength = buffer.readUInt16BE(offset);
  offset += 2 + cipherLength;
  if (offset + 1 > buffer.length) return null;
  const compressionLength = buffer[offset];
  offset += 1 + compressionLength;
  if (offset + 2 > buffer.length) return null;
  const extensionsLength = buffer.readUInt16BE(offset);
  offset += 2;
  const extensionsEnd = Math.min(offset + extensionsLength, 9 + helloLength);

  while (offset + 4 <= extensionsEnd) {
    const type = buffer.readUInt16BE(offset);
    const length = buffer.readUInt16BE(offset + 2);
    offset += 4;
    if (offset + length > extensionsEnd) return null;
    if (type === 0x0000 && length >= 5) {
      const listLength = buffer.readUInt16BE(offset);
      let nameOffset = offset + 2;
      const listEnd = Math.min(nameOffset + listLength, offset + length);
      while (nameOffset + 3 <= listEnd) {
        const nameType = buffer[nameOffset];
        const nameLength = buffer.readUInt16BE(nameOffset + 1);
        nameOffset += 3;
        if (nameOffset + nameLength > listEnd) break;
        if (nameType === 0) return buffer.subarray(nameOffset, nameOffset + nameLength).toString('utf8').toLowerCase();
        nameOffset += nameLength;
      }
    }
    offset += length;
  }
  return null;
}

function proxy(socket, port, initialData) {
  const upstream = net.connect({host: '127.0.0.1', port});
  let connected = false;
  upstream.on('connect', () => {
    connected = true;
    upstream.write(initialData);
    socket.pipe(upstream);
    upstream.pipe(socket);
    socket.resume();
  });
  upstream.on('error', () => socket.destroy());
  upstream.on('close', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => { if (!connected) upstream.destroy(); });
}

const server = net.createServer(socket => {
  socket.pause();
  socket.setTimeout(10000, () => socket.destroy());
  const chunks = [];
  let total = 0;
  let decided = false;

  const onData = chunk => {
    if (decided) return;
    chunks.push(chunk);
    total += chunk.length;
    if (total > 128 * 1024) return choose(null);
    const initialData = Buffer.concat(chunks, total);
    let host;
    try { host = readServerName(initialData); } catch { host = null; }
    if (host === undefined) return;
    choose(host, initialData);
  };

  function choose(host, initialData = Buffer.concat(chunks, total)) {
    if (decided) return;
    decided = true;
    socket.removeListener('data', onData);
    socket.setTimeout(0);
    proxy(socket, CODEX_HOSTS.has(host) ? CODEX_PORT : XRAY_PORT, initialData);
  }

  socket.on('data', onData);
  socket.on('error', () => {});
  socket.resume();
});

server.on('error', error => {
  console.error(`TLS router error: ${error.message}`);
  process.exitCode = 1;
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`TLS router listening on ${LISTEN_HOST}:${LISTEN_PORT}`);
});
