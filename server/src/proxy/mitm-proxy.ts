/**
 * MITM Proxy server for intercepting game traffic.
 *
 * Intercepts WebSocket connections to the official servers and redirects
 * them to the local private server. Passes through CDN resource requests.
 *
 * Note: This is a simplified HTTP proxy. For full HTTPS MITM, you would need
 * to generate a self-signed CA certificate and configure the client to trust it.
 * Since the Majsoul client doesn't verify server certificates, a simpler approach
 * is to use DNS/hosts file redirection instead.
 */

import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const PROXY_PORT = 23410;
const LOBBY_HOST = '127.0.0.1';
const LOBBY_PORT = 8441;
const GAME_HOST = '127.0.0.1';
const GAME_PORT = 8443;

export function startMITMProxy(): void {
  const server = http.createServer((req, res) => {
    // Pass through HTTP requests (CDN resources)
    console.log(`[proxy] HTTP ${req.method} ${req.url}`);

    const options = {
      hostname: req.headers.host?.split(':')[0] || 'mahjongsoul.game.yo-star.com',
      port: parseInt(req.headers.host?.split(':')[1] || '443'),
      path: req.url,
      method: req.method,
      headers: req.headers,
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      console.error('[proxy] HTTP proxy error:', err.message);
      res.writeHead(502);
      res.end('Proxy error');
    });

    req.pipe(proxyReq);
  });

  // Handle WebSocket upgrade
  server.on('upgrade', (req, socket, head) => {
    const url = req.url || '/';
    console.log(`[proxy] WebSocket upgrade: ${url}`);

    // Route based on URL pattern
    let targetHost: string;
    let targetPort: number;

    if (url.includes('lobby') || url === '/') {
      targetHost = LOBBY_HOST;
      targetPort = LOBBY_PORT;
    } else {
      targetHost = GAME_HOST;
      targetPort = GAME_PORT;
    }

    // Connect to local server
    const targetWs = new WebSocket(`ws://${targetHost}:${targetPort}${url}`);

    targetWs.on('open', () => {
      console.log(`[proxy] Connected to ${targetHost}:${targetPort}`);
    });

    targetWs.on('message', (data: Buffer) => {
      if (socket.writable) {
        socket.write(createWsFrame(data));
      }
    });

    targetWs.on('close', () => {
      socket.destroy();
    });

    targetWs.on('error', (err) => {
      console.error('[proxy] Target WebSocket error:', err.message);
      socket.destroy();
    });
  });

  server.listen(PROXY_PORT, () => {
    console.log(`[proxy] MITM proxy server started on port ${PROXY_PORT}`);
  });
}

/**
 * Create a WebSocket frame from raw data (simplified - binary frame only)
 */
function createWsFrame(data: Buffer): Buffer {
  const payloadLen = data.length;
  const frames: Buffer[] = [];

  // Opcode 0x02 = binary frame, FIN bit set
  frames.push(Buffer.from([0x82]));

  if (payloadLen < 126) {
    frames.push(Buffer.from([payloadLen]));
  } else if (payloadLen < 65536) {
    frames.push(Buffer.from([126]));
    const lenBuf = Buffer.alloc(2);
    lenBuf.writeUInt16BE(payloadLen, 0);
    frames.push(lenBuf);
  } else {
    frames.push(Buffer.from([127]));
    const lenBuf = Buffer.alloc(8);
    lenBuf.writeBigUInt64BE(BigInt(payloadLen), 0);
    frames.push(lenBuf);
  }

  frames.push(data);
  return Buffer.concat(frames);
}
