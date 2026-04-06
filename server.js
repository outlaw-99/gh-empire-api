const dgram = require('dgram');
const http = require('http');
const url = require('url');

const SAMP_IP = '51.68.107.75';
const SAMP_PORT = 19643;
const API_PORT = 3000;

// Cache so the website doesn't hammer the game server
let cache = { data: null, lastFetch: 0 };
const CACHE_TTL = 10000; // 10 seconds

// ─── SA-MP UDP Query Protocol ─────────────────────────────────────────────────
function querySAMP(type) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('SA-MP server timed out'));
    }, 4000);

    // Build the SAMP query packet
    const ipParts = SAMP_IP.split('.').map(Number);
    const portLow  = SAMP_PORT & 0xFF;
    const portHigh = (SAMP_PORT >> 8) & 0xFF;

    const packet = Buffer.alloc(11);
    packet.write('SAMP', 0, 'ascii');
    packet[4] = ipParts[0];
    packet[5] = ipParts[1];
    packet[6] = ipParts[2];
    packet[7] = ipParts[3];
    packet[8] = portLow;
    packet[9] = portHigh;
    packet[10] = type.charCodeAt(0); // 'i' = info, 'r' = rules, 'c' = client list

    socket.on('message', (msg) => {
      clearTimeout(timeout);
      socket.close();
      resolve(msg);
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      socket.close();
      reject(err);
    });

    socket.send(packet, 0, packet.length, SAMP_PORT, SAMP_IP);
  });
}

// Parse the 'i' (info) packet response
function parseInfoPacket(buf) {
  if (buf.length < 11) throw new Error('Packet too short');

  let offset = 11; // skip the header echo

  const isPassword  = buf.readUInt8(offset++);
  const players     = buf.readUInt16LE(offset); offset += 2;
  const maxPlayers  = buf.readUInt16LE(offset); offset += 2;

  const hostnameLen = buf.readUInt32LE(offset); offset += 4;
  const hostname    = buf.toString('ascii', offset, offset + hostnameLen); offset += hostnameLen;

  const gamemodeLen = buf.readUInt32LE(offset); offset += 4;
  const gamemode    = buf.toString('ascii', offset, offset + gamemodeLen); offset += gamemodeLen;

  const languageLen = buf.readUInt32LE(offset); offset += 4;
  const language    = buf.toString('ascii', offset, offset + languageLen);

  return { hostname, players, maxPlayers, gamemode, language, isPassword: !!isPassword };
}

// Parse the 'c' (basic client list) packet
function parseClientsPacket(buf) {
  let offset = 11;
  const count = buf.readUInt16LE(offset); offset += 2;
  const players = [];

  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt8(offset++);
    const name    = buf.toString('ascii', offset, offset + nameLen); offset += nameLen;
    const score   = buf.readInt32LE(offset); offset += 4;
    players.push({ name, score });
  }
  return players;
}

// ─── Fetch & Cache Server Data ────────────────────────────────────────────────
async function fetchServerData() {
  const now = Date.now();
  if (cache.data && (now - cache.lastFetch) < CACHE_TTL) {
    return cache.data;
  }

  try {
    const [infoBuf, clientBuf] = await Promise.all([
      querySAMP('i'),
      querySAMP('c'),
    ]);

    const info    = parseInfoPacket(infoBuf);
    const players = parseClientsPacket(clientBuf);

    const data = {
      online: true,
      hostname: info.hostname,
      players: info.players,
      maxPlayers: info.maxPlayers,
      gamemode: info.gamemode,
      language: info.language,
      isPassword: info.isPassword,
      playerList: players.sort((a, b) => b.score - a.score),
      ip: SAMP_IP,
      port: SAMP_PORT,
      fetchedAt: new Date().toISOString(),
    };

    cache = { data, lastFetch: now };
    return data;

  } catch (err) {
    console.error('SA-MP query error:', err.message);
    const fallback = {
      online: false,
      hostname: 'GH EMPIRE RP',
      players: 0,
      maxPlayers: 100,
      gamemode: 'Unknown',
      language: 'English',
      isPassword: false,
      playerList: [],
      ip: SAMP_IP,
      port: SAMP_PORT,
      fetchedAt: new Date().toISOString(),
      error: err.message,
    };
    // cache the offline state briefly so we don't spam retry
    cache = { data: fallback, lastFetch: now - CACHE_TTL + 3000 };
    return fallback;
  }
}

// ─── HTTP API Server ──────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS – allow your website domain
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const { pathname } = url.parse(req.url);

  if (pathname === '/api/server') {
    try {
      const data = await fetchServerData();
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (pathname === '/api/players') {
    try {
      const data = await fetchServerData();
      res.writeHead(200);
      res.end(JSON.stringify({ players: data.playerList, total: data.players }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(API_PORT, () => {
  console.log(`✅ GH Empire API running on http://localhost:${API_PORT}`);
  console.log(`   Querying SA-MP server: ${SAMP_IP}:${SAMP_PORT}`);
  console.log(`   Endpoints:`);
  console.log(`     GET /api/server  → full server info + player list`);
  console.log(`     GET /api/players → player list only`);
  console.log(`     GET /health      → health check`);
});
