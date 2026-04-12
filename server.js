const dgram = require('dgram');
const http = require('http');
const url = require('url');
const mysql = require('mysql2/promise');
// Whirlpool hash - matches WP_Hash in SA-MP
// Requires --openssl-legacy-provider flag (set in package.json start script)
const crypto = require('crypto');
function whirlpool(str) {
  return crypto.createHash('whirlpool').update(str, 'utf8').digest('hex');
}


const SAMP_IP = '51.68.107.75';
const SAMP_PORT = 19643;
const API_PORT = 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'ghempire2025';

// MySQL pool
const db = mysql.createPool({
  host: process.env.DB_HOST || '51.68.107.75',
  user: process.env.DB_USER || 'u86036_LdcPtIRvUc',
  password: process.env.DB_PASS || 'BpTUlCgjNFE.mZeeAWu5HjIq',
  database: process.env.DB_NAME || 's86036_Nanayaw',
  waitForConnections: true,
  connectionLimit: 5,
});

// Cache
let cache = { data: null, lastFetch: 0 };
const CACHE_TTL = 10000;

// ── SA-MP UDP QUERY ──
function querySAMP(type) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const timeout = setTimeout(() => { socket.close(); reject(new Error('Timeout')); }, 4000);
    const ipParts = SAMP_IP.split('.').map(Number);
    const packet = Buffer.alloc(11);
    packet.write('SAMP', 0, 'ascii');
    packet[4]=ipParts[0]; packet[5]=ipParts[1]; packet[6]=ipParts[2]; packet[7]=ipParts[3];
    packet[8]=SAMP_PORT&0xFF; packet[9]=(SAMP_PORT>>8)&0xFF; packet[10]=type.charCodeAt(0);
    socket.on('message', msg => { clearTimeout(timeout); socket.close(); resolve(msg); });
    socket.on('error', err => { clearTimeout(timeout); socket.close(); reject(err); });
    socket.send(packet, 0, packet.length, SAMP_PORT, SAMP_IP);
  });
}

function parseInfoPacket(buf) {
  let o = 11;
  const isPassword = buf.readUInt8(o++);
  const players = buf.readUInt16LE(o); o+=2;
  const maxPlayers = buf.readUInt16LE(o); o+=2;
  const hnLen = buf.readUInt32LE(o); o+=4;
  const hostname = buf.toString('ascii', o, o+hnLen); o+=hnLen;
  const gmLen = buf.readUInt32LE(o); o+=4;
  const gamemode = buf.toString('ascii', o, o+gmLen); o+=gmLen;
  const lnLen = buf.readUInt32LE(o); o+=4;
  const language = buf.toString('ascii', o, o+lnLen);
  return { hostname, players, maxPlayers, gamemode, language, isPassword: !!isPassword };
}

function parseClientsPacket(buf) {
  let o = 11;
  const count = buf.readUInt16LE(o); o+=2;
  const players = [];
  for(let i=0;i<count;i++){
    const nLen=buf.readUInt8(o++);
    const name=buf.toString('ascii',o,o+nLen); o+=nLen;
    const score=buf.readInt32LE(o); o+=4;
    players.push({name,score});
  }
  return players;
}

async function fetchServerData() {
  const now = Date.now();
  if(cache.data && (now-cache.lastFetch)<CACHE_TTL) return cache.data;
  try {
    const [infoBuf, clientBuf] = await Promise.all([querySAMP('i'), querySAMP('c')]);
    const info = parseInfoPacket(infoBuf);
    const players = parseClientsPacket(clientBuf);
    const data = { online:true, hostname:info.hostname, players:info.players, maxPlayers:info.maxPlayers, gamemode:info.gamemode, language:info.language, isPassword:info.isPassword, playerList:players.sort((a,b)=>b.score-a.score), ip:SAMP_IP, port:SAMP_PORT, fetchedAt:new Date().toISOString() };
    cache = { data, lastFetch:now };
    return data;
  } catch(err) {
    const fallback = { online:false, hostname:'GH Empire RP', players:0, maxPlayers:200, gamemode:'Roleplay', language:'English', isPassword:false, playerList:[], ip:SAMP_IP, port:SAMP_PORT, fetchedAt:new Date().toISOString(), error:err.message };
    cache = { data:fallback, lastFetch:now-CACHE_TTL+3000 };
    return fallback;
  }
}

// ── CORS HELPER ──
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
}

function ok(res, data) { res.writeHead(200); res.end(JSON.stringify(data)); }
function fail(res, msg, code=400) { res.writeHead(code); res.end(JSON.stringify({error:msg,success:false})); }

// ── READ BODY ──
function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body+=c);
    req.on('end', () => { try{ resolve(JSON.parse(body)); }catch{ resolve({}); } });
  });
}

// ── HTTP SERVER ──
const server = http.createServer(async (req, res) => {
  setCORS(res);
  if(req.method==='OPTIONS'){ res.writeHead(204); res.end(); return; }

  const { pathname } = url.parse(req.url);

  // ── GET ROUTES ──
  if(req.method==='GET') {
    if(pathname==='/health'){ ok(res,{status:'ok',uptime:process.uptime()}); return; }

    if(pathname==='/api/server'){
      try{ ok(res, await fetchServerData()); }catch(e){ fail(res,e.message,500); }
      return;
    }

    if(pathname==='/api/players'){
      try{
        const [rows] = await db.query('SELECT username as name, level, cash, bank, faction FROM users ORDER BY cash DESC LIMIT 50');
        ok(res, {players:rows});
      }catch(e){ fail(res,e.message,500); }
      return;
    }

    if(pathname==='/api/stats'){
      try{
        const [[row]] = await db.query("SELECT COUNT(*) as total FROM users WHERE username != ''");
        ok(res, {totalPlayers: row.total});
      }catch(e){ fail(res,e.message,500); }
      return;
    }

    if(pathname==='/api/top/richest'){
      try{
        const [rows] = await db.query('SELECT username as name, bank FROM users ORDER BY bank DESC LIMIT 10');
        ok(res,{players:rows});
      }catch(e){ fail(res,e.message,500); }
      return;
    }

    if(pathname==='/api/top/level'){
      try{
        const [rows] = await db.query('SELECT username as name, level FROM users ORDER BY level DESC LIMIT 10');
        ok(res,{players:rows});
      }catch(e){ fail(res,e.message,500); }
      return;
    }

    if(pathname==='/api/top/criminals'){
      try{
        const [rows] = await db.query('SELECT username as name, crimes FROM users ORDER BY crimes DESC LIMIT 10');
        ok(res,{players:rows});
      }catch(e){ fail(res,e.message,500); }
      return;
    }

    res.writeHead(404); res.end(JSON.stringify({error:'Not found'}));
    return;
  }

  // ── ACCOUNT LOOKUP ──
  if(req.method==='POST' && pathname==='/api/lookup'){
    const body = await readBody(req);
    const username = (body.username||'').trim();
    const password = (body.password||'').trim();
    if(!username||!password){ fail(res,'Username and password required'); return; }
    try{
      const hashedPass = whirlpool(password);
      const [rows] = await db.query(
        `SELECT u.username as name, u.level, u.cash, u.bank, u.hours, u.crimes, u.arrested,
         u.job, u.warnings, u.vippackage as vip, u.dirtycash,
         u.faction as factionId, u.gang as gangId,
         f.name as factionName, g.name as gangName
         FROM users u
         LEFT JOIN factions f ON u.faction = f.id AND u.faction >= 0
         LEFT JOIN gangs g ON u.gang = g.id AND u.gang >= 0
         WHERE u.username = ? AND u.password = ? LIMIT 1`,
        [username, hashedPass]
      );
      if(rows.length) {
        const r = rows[0];
        if(r.factionName) r.group = r.factionName;
        else if(r.gangName) r.group = r.gangName;
        else r.group = 'Civilian';
      }
      if(!rows.length){ fail(res,'Wrong username or password.'); return; }
      ok(res, { success: true, player: rows[0] });
    }catch(e){
      fail(res,'Database error: '+e.message, 500);
    }
    return;
  }

  // ── POST ADMIN ROUTES ──
  if(req.method==='POST' && pathname.startsWith('/api/admin/')) {
    const body = await readBody(req);
    if(body.adminPass !== ADMIN_SECRET){ fail(res,'Unauthorized',401); return; }

    const player = (body.player||'').trim();
    const value = body.value;
    if(!player){ fail(res,'Player name required'); return; }

    const action = pathname.replace('/api/admin/','');

    try{
      // Case-insensitive partial name search
      const [matches] = await db.query('SELECT uid, username, level, cash, bank FROM users WHERE username LIKE ? LIMIT 10', ['%'+player+'%']);

      // No results
      if(matches.length === 0 && action !== 'unban'){
        fail(res, 'No player found matching "'+player+'". Check the name and try again.');
        return;
      }

      // Multiple results — ask admin to be more specific
      if(matches.length > 1 && action !== 'unban'){
        const names = matches.map((m,i) => (i+1)+'. '+m.username+' (Lvl '+m.level+')').join(' | ');
        fail(res, 'Multiple players found: '+names+' — Type the full exact name to continue.');
        return;
      }

      const user = matches[0];
      const exactName = user ? user.username : player;

      switch(action) {
        case 'givemoney': {
          const amount = parseInt(value);
          if(isNaN(amount)||amount<=0){ fail(res,'Invalid amount'); return; }
          await db.query('UPDATE users SET cash = cash + ? WHERE username = ?', [amount,exactName]);
          ok(res,{success:true, message:`✅ Gave $${amount.toLocaleString()} cash to ${exactName}`});
          break;
        }
        case 'givebank': {
          const amount = parseInt(value);
          if(isNaN(amount)||amount<=0){ fail(res,'Invalid amount'); return; }
          await db.query('UPDATE users SET bank = bank + ? WHERE username = ?', [amount,exactName]);
          ok(res,{success:true, message:`✅ Gave $${amount.toLocaleString()} bank to ${exactName}`});
          break;
        }
        case 'takemoney': {
          const amount = parseInt(value);
          if(isNaN(amount)||amount<=0){ fail(res,'Invalid amount'); return; }
          await db.query('UPDATE users SET cash = GREATEST(0, cash - ?) WHERE username = ?', [amount,exactName]);
          ok(res,{success:true, message:`✅ Took $${amount.toLocaleString()} cash from ${exactName}`});
          break;
        }
        case 'setlevel': {
          const level = parseInt(value);
          if(isNaN(level)||level<1||level>100){ fail(res,'Level must be 1-100'); return; }
          await db.query('UPDATE users SET level = ? WHERE username = ?', [level,exactName]);
          ok(res,{success:true, message:`✅ Set ${exactName}'s level to ${level}`});
          break;
        }
        case 'setadmin': {
          const level = parseInt(value);
          if(isNaN(level)||level<0||level>7){ fail(res,'Admin level must be 0-7'); return; }
          await db.query('UPDATE users SET adminlevel = ? WHERE username = ?', [level,exactName]);
          ok(res,{success:true, message:`✅ Set ${exactName}'s admin level to ${level}`});
          break;
        }
        case 'ban': {
          const reason = value||'No reason';
          await db.query("INSERT INTO bans (username, ip, reason, date) VALUES (?, '0.0.0.0', ?, NOW()) ON DUPLICATE KEY UPDATE reason=VALUES(reason), date=NOW()", [player, reason]);
          ok(res,{success:true, message:`✅ Banned ${exactName} — Reason: ${reason}`});
          break;
        }
        case 'unban': {
          await db.query('DELETE FROM bans WHERE username = ?', [exactName]);
          ok(res,{success:true, message:`✅ Unbanned ${exactName}`});
          break;
        }
        case 'resetpass': {
          if(!value||value.length<4){ fail(res,'Password must be at least 4 characters'); return; }
          await db.query('UPDATE users SET password = ? WHERE username = ?', [value,exactName]);
          ok(res,{success:true, message:`✅ Password reset for ${exactName}`});
          break;
        }
        case 'search': {
          const [[p]] = await db.query('SELECT username as name, level, cash, bank, admin as adminLevel, crimes, faction FROM users WHERE username = ?', [exactName]);
          if(!p){ fail(res,`Player "${player}" not found`); return; }
          ok(res,{success:true, player:p, message:`Found: ${p.name} | Level ${p.level} | Cash $${Number(p.cash).toLocaleString()} | Bank $${Number(p.bank).toLocaleString()} | Admin Lvl ${p.adminLevel} | Crimes ${p.crimes} | Faction: ${p.faction||'None'}`});
          break;
        }
        default:
          fail(res,'Unknown action');
      }
    }catch(e){
      console.error('Admin action error:', e.message);
      fail(res, 'Database error: ' + e.message, 500);
    }
    return;
  }

  // ── CREATE ORDER ──
  if(req.method==='POST' && pathname==='/api/orders/create'){
    const body = await readBody(req);
    const { username, item, itemType, price, coins } = body;
    if(!username||!item){ fail(res,'Missing fields'); return; }
    try{
      const orderId = Date.now().toString(36).toUpperCase();
      await db.query(
        'INSERT INTO shop_orders (order_id, username, item, item_type, price, coins, status, created_at) VALUES(?,?,?,?,?,?,'pending',NOW())',
        [orderId, username, item, itemType||'', price||'', coins||0]
      );
      ok(res,{success:true, orderId});
    }catch(e){
      // Table might not exist, create it
      try{
        await db.query(`CREATE TABLE IF NOT EXISTS shop_orders (
          id INT AUTO_INCREMENT PRIMARY KEY,
          order_id VARCHAR(20) UNIQUE,
          username VARCHAR(64),
          item VARCHAR(128),
          item_type VARCHAR(64),
          price VARCHAR(32),
          coins INT DEFAULT 0,
          status ENUM('pending','approved','rejected') DEFAULT 'pending',
          created_at DATETIME,
          approved_at DATETIME NULL,
          approved_by VARCHAR(64) NULL
        )`);
        const orderId = Date.now().toString(36).toUpperCase();
        await db.query(
          'INSERT INTO shop_orders (order_id, username, item, item_type, price, coins, status, created_at) VALUES(?,?,?,?,?,?,'pending',NOW())',
          [orderId, username, item, itemType||'', price||'', coins||0]
        );
        ok(res,{success:true, orderId});
      }catch(e2){ fail(res,'DB error: '+e2.message,500); }
    }
    return;
  }

  // ── GET ORDERS (admin) ──
  if(req.method==='POST' && pathname==='/api/orders/list'){
    const body = await readBody(req);
    if(body.adminPass !== ADMIN_SECRET){ fail(res,'Unauthorized',401); return; }
    try{
      const status = body.status || 'pending';
      const [rows] = await db.query(
        'SELECT * FROM shop_orders WHERE status=? ORDER BY created_at DESC LIMIT 50',
        [status]
      );
      ok(res,{success:true, orders:rows});
    }catch(e){ fail(res,'DB error: '+e.message,500); }
    return;
  }

  // ── APPROVE / REJECT ORDER ──
  if(req.method==='POST' && pathname==='/api/orders/action'){
    const body = await readBody(req);
    if(body.adminPass !== ADMIN_SECRET){ fail(res,'Unauthorized',401); return; }
    const { orderId, action, adminName } = body;
    if(!orderId||!action){ fail(res,'Missing fields'); return; }
    try{
      // Get order
      const [[order]] = await db.query('SELECT * FROM shop_orders WHERE order_id=?',[orderId]);
      if(!order){ fail(res,'Order not found'); return; }

      if(action === 'approve'){
        // Get player uid
        const [[user]] = await db.query('SELECT uid, username FROM users WHERE username=?',[order.username]);
        if(!user){ fail(res,'Player not found in database'); return; }

        // Apply item based on type
        const type = order.item_type;
        if(type === 'vip_bronze'){
          await db.query('UPDATE users SET vippackage=1, viptime=viptime+2592000 WHERE uid=?',[user.uid]);
        } else if(type === 'vip_silver'){
          await db.query('UPDATE users SET vippackage=2, viptime=viptime+2592000 WHERE uid=?',[user.uid]);
        } else if(type === 'vip_gold'){
          await db.query('UPDATE users SET vippackage=3, viptime=viptime+2592000 WHERE uid=?',[user.uid]);
        } else if(type.startsWith('car_')){
          const modelId = parseInt(type.replace('car_',''));
          if(modelId > 0){
            await db.query(
              "INSERT INTO vehicles (ownerid, owner, modelid, price, pos_x, pos_y, pos_z, pos_a) VALUES(?,?,?,0,'557.7865','-1274.3177','17.2422','0.0000')",
              [user.uid, user.username, modelId]
            );
          }
        } else if(type === 'cash_500k'){
          await db.query('UPDATE users SET cash=cash+500000 WHERE uid=?',[user.uid]);
        } else if(type === 'cash_2m'){
          await db.query('UPDATE users SET cash=cash+2000000 WHERE uid=?',[user.uid]);
        } else if(type === 'cash_10m'){
          await db.query('UPDATE users SET cash=cash+10000000 WHERE uid=?',[user.uid]);
        } else if(type === 'coins'){
          await db.query('UPDATE users SET coins=COALESCE(coins,0)+? WHERE uid=?',[order.coins, user.uid]);
        } else if(type.startsWith('house_')){
          // House needs a specific house ID from admin
          const houseId = body.houseId ? parseInt(body.houseId) : null;
          if(!houseId){ fail(res,'Please enter a House ID to assign'); return; }
          // Check house exists and is not owned
          const [[house]] = await db.query('SELECT id, owner FROM houses WHERE id=? LIMIT 1',[houseId]);
          if(!house){ fail(res,'House ID '+houseId+' not found'); return; }
          if(house.owner && house.owner !== '' && house.owner !== 'none' && house.owner !== 'None'){
            fail(res,'House '+houseId+' is already owned by '+house.owner); return;
          }
          await db.query(
            'UPDATE houses SET ownerid=?, owner=?, timestamp=? WHERE id=?',
            [user.uid, user.username, Math.floor(Date.now()/1000), houseId]
          );
        }
        // Mark approved
        await db.query(
          'UPDATE shop_orders SET status='approved', approved_at=NOW(), approved_by=? WHERE order_id=?',
          [adminName||'Admin', orderId]
        );
        ok(res,{success:true, message:'✅ Order approved and item delivered to '+order.username});
      } else if(action === 'reject'){
        await db.query('UPDATE shop_orders SET status='rejected', approved_by=? WHERE order_id=?',[adminName||'Admin', orderId]);
        ok(res,{success:true, message:'❌ Order rejected'});
      } else {
        fail(res,'Unknown action');
      }
    }catch(e){ fail(res,'DB error: '+e.message,500); }
    return;
  }

  res.writeHead(404); res.end(JSON.stringify({error:'Not found'}));
});

server.listen(API_PORT, () => {
  console.log(`✅ GH Empire API running on http://localhost:${API_PORT}`);
  console.log(`   SA-MP: ${SAMP_IP}:${SAMP_PORT}`);
});
