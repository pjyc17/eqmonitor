const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');
const graph = require('./graph');

const app = express();

const redirectApp = express();
redirectApp.use((req, res) => {
  const host = (req.headers.host || '').replace(`:${3000}`, `:${3443}`);
  res.redirect(301, `https://${host}${req.url}`);
});
const server = http.createServer(redirectApp);

const sslOptions = {
  key: fs.readFileSync(path.join(__dirname, 'key.pem')),
  cert: fs.readFileSync(path.join(__dirname, 'cert.pem')),
};
const httpsServer = https.createServer(sslOptions, app);

const io = new Server(httpsServer);

app.use(express.json());

const LINE_CONFIG = {
  'A': {start:1, end:25}, 'B': {start:1, end:25}, 'C': {start:1, end:25}, 'D': {start:1, end:25}, 'E': {start:1, end:25},
  'F': {start:6, end:19}, 'G': {start:6, end:19}, 'H': {start:5, end:19}, 'I': {start:5, end:19},
  'J': {start:1, end:10}, 'K': {start:1, end:10}, 'L': {start:1, end:10}, 'M': {start:1, end:10},
  'IA': {start:1, end:5}, 'IB': {start:1, end:5}, 'IC': {start:1, end:5}, 'ID': {start:1, end:5},
};
const LINE_NAMES = Object.keys(LINE_CONFIG);
const DATA_FILE = path.join(__dirname, 'data.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const LOG_FILE = path.join(__dirname, 'log.json');
const NOTIF_FILE = path.join(__dirname, 'notifications.json');

function loadNotifications() {
  try {
    if (fs.existsSync(NOTIF_FILE)) return JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8'));
  } catch (e) {}
  return {};
}
function saveNotifications() { atomicWrite(NOTIF_FILE, notifications); }
const notifications = loadNotifications();
let pendingSlots = [];

const PARSED_SCHEDULE_FILE = path.join(__dirname, 'parsed-schedule.json');
function loadParsedSchedule() {
  try { return JSON.parse(fs.readFileSync(PARSED_SCHEDULE_FILE, 'utf8')); } catch { return null; }
}
function saveParsedSchedule(data) {
  if (data) atomicWrite(PARSED_SCHEDULE_FILE, data);
  else try { fs.unlinkSync(PARSED_SCHEDULE_FILE); } catch {}
}
let parsedSchedule = loadParsedSchedule();

const CAMERAS_FILE = path.join(__dirname, 'cameras.json');

function createDefaultCameras() {
  return {
    cam1: { status: 'green', takenBy: null, takenAt: null },
    cam2: { status: 'green', takenBy: null, takenAt: null },
    cam3: { status: 'green', takenBy: null, takenAt: null },
  };
}

function loadCameras() {
  try {
    if (fs.existsSync(CAMERAS_FILE)) return JSON.parse(fs.readFileSync(CAMERAS_FILE, 'utf8'));
  } catch (e) {}
  return createDefaultCameras();
}

let camSaveTimer = null;
function saveCameras() {
  if (camSaveTimer) return;
  camSaveTimer = setTimeout(() => {
    camSaveTimer = null;
    atomicWrite(CAMERAS_FILE, cameras);
  }, 500);
}

const cameras = loadCameras();

const REPORT_CONFIG_FILE = path.join(__dirname, 'report-config.json');

function loadReportConfig() {
  try {
    if (fs.existsSync(REPORT_CONFIG_FILE)) return JSON.parse(fs.readFileSync(REPORT_CONFIG_FILE, 'utf8'));
  } catch (e) {}
  return { recipients: [] };
}

function saveReportConfig(config) { atomicWrite(REPORT_CONFIG_FILE, config); }

const WEBHOOK_FILE = path.join(__dirname, 'webhook.json');
function loadWebhook() {
  try { if (fs.existsSync(WEBHOOK_FILE)) return JSON.parse(fs.readFileSync(WEBHOOK_FILE, 'utf8')); } catch(e) {}
  return {};
}
function saveWebhook(cfg) { fs.writeFileSync(WEBHOOK_FILE, JSON.stringify(cfg, null, 2), 'utf8'); }

function sendTeamsWebhook(text) {
  const cfg = loadWebhook();
  if (!cfg.url) return;
  const payload = JSON.stringify({ text });
  const parsed = new URL(cfg.url);
  const options = {
    hostname: parsed.hostname, port: parsed.port || 443,
    path: parsed.pathname + parsed.search,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
  };
  const req = https.request(options, () => {});
  req.on('error', () => {});
  req.write(payload);
  req.end();
}

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

// ── 사용자 & 세션 관리 ──
const SESSIONS_FILE = path.join(__dirname, 'sessions.json');
const sessions = new Map();

function loadSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
      for (const [token, userId] of Object.entries(data)) {
        sessions.set(token, userId);
      }
      console.log(`  세션 ${sessions.size}건 복원`);
    }
  } catch (err) {
    console.log('  세션 복원 실패:', err.message);
  }
}

function saveSessions() {
  const obj = {};
  sessions.forEach((userId, token) => { obj[token] = userId; });
  atomicWrite(SESSIONS_FILE, obj);
}

loadSessions();

function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    }
  } catch (err) {
    console.log('  사용자 데이터 로드 실패:', err.message);
  }
  const defaultUsers = {
    admin: { id: 'admin', pw: 'admin', name: '관리자', dept: '관리', role: 'admin', createdAt: Date.now() }
  };
  atomicWrite(USERS_FILE, defaultUsers);
  console.log('  기본 관리자 계정 생성 (admin/admin)');
  return defaultUsers;
}

const users = loadUsers();

function saveUsers() {
  atomicWrite(USERS_FILE, users);
}

function monthKey(time) {
  const d = new Date(time);
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
}
function monthLogFile(key) {
  return path.join(__dirname, `log-${key}.json`);
}
function readMonthLog(key) {
  try {
    const f = monthLogFile(key);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch(e) {}
  return [];
}
function writeMonthLog(key, data) {
  atomicWrite(monthLogFile(key), data);
}

function loadLogs() {
  // 기존 log.json → 월별 파일로 마이그레이션
  if (fs.existsSync(LOG_FILE)) {
    try {
      const old = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
      if (old.length > 0) {
        const byMonth = {};
        old.forEach(l => {
          const k = monthKey(l.time || Date.now());
          if (!byMonth[k]) byMonth[k] = [];
          byMonth[k].push(l);
        });
        for (const k in byMonth) {
          const existing = readMonthLog(k);
          writeMonthLog(k, existing.concat(byMonth[k]));
        }
        fs.renameSync(LOG_FILE, LOG_FILE + '.migrated');
        console.log(`  [로그] log.json → 월별 파일 마이그레이션 완료 (${old.length}건)`);
      }
    } catch(e) { console.error('  [로그] 마이그레이션 오류:', e.message); }
  }

  const all = [];
  const files = fs.readdirSync(__dirname).filter(f => /^log-\d{4}-\d{2}\.json$/.test(f)).sort();
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, f), 'utf8'));
      all.push(...data);
    } catch(e) {}
  }
  return all.sort((a, b) => (a.time||0) - (b.time||0));
}

const logs = loadLogs();

function cleanOldLogs() {
  const cutoff = Date.now() - 400 * 24 * 60 * 60 * 1000;
  const before = logs.length;
  while (logs.length > 0 && logs[0].time && logs[0].time < cutoff) logs.shift();
  const removed = before - logs.length;

  const files = fs.readdirSync(__dirname).filter(f => /^log-\d{4}-\d{2}\.json$/.test(f));
  for (const f of files) {
    const m = f.match(/^log-(\d{4})-(\d{2})\.json$/);
    if (!m) continue;
    const lastDay = new Date(parseInt(m[1]), parseInt(m[2]), 0).getTime();
    if (lastDay < cutoff) {
      fs.unlinkSync(path.join(__dirname, f));
      console.log(`  [로그정리] ${f} 삭제 (90일 초과)`);
    }
  }
  if (removed > 0) console.log(`  [로그정리] 메모리에서 ${removed}건 제거, 남은 ${logs.length}건`);
}
cleanOldLogs();

function addLog(action, userId, userName, detail, equipInfo) {
  const entry = { time: Date.now(), action, userId, userName, detail };
  if (equipInfo) {
    entry.equipmentId = equipInfo.equipmentId;
    entry.equipName = equipInfo.equipName;
    entry.line = equipInfo.line;
    entry.slotNumber = equipInfo.slotNumber;
  }
  logs.push(entry);
  const k = monthKey(entry.time);
  const monthData = readMonthLog(k);
  monthData.push(entry);
  writeMonthLog(k, monthData);
}

function getUserByToken(token) {
  if (!token) return null;
  const userId = sessions.get(token);
  if (!userId) return null;
  return users[userId] || null;
}

// ── 인증 API (로그인 없이 접근 가능) ──
app.post('/api/login', (req, res) => {
  const { id, pw } = req.body;
  const user = users[id];
  if (!user || user.pw !== pw) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 틀렸습니다' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, id);
  saveSessions();
  addLog('login', id, user.name, '로그인');
  io.emit('newLog');
  res.json({ token, user: { id: user.id, name: user.name, dept: user.dept, role: user.role } });
});

app.get('/api/me', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ error: '로그인이 필요합니다' });
  res.json({ id: user.id, name: user.name, dept: user.dept, role: user.role });
});

app.post('/api/register', (req, res) => {
  const { id, pw, name, dept } = req.body;
  if (!id || !pw || !name || !dept) return res.status(400).json({ error: '모든 항목을 입력해주세요' });
  if (users[id]) return res.status(400).json({ error: '이미 존재하는 ID입니다' });
  users[id] = { id, pw, name, dept, role: 'user', createdAt: Date.now() };
  saveUsers();
  addLog('register', id, name, `회원가입 (소속: ${dept})`);
  io.emit('newLog');
  const regNotif = {
    id: `reg-${Date.now()}`,
    type: 'register',
    title: '새 회원가입',
    body: `${name} (${dept}) / ID: ${id}`,
    time: Date.now()
  };
  if (!notifications['__pjyc17__']) notifications['__pjyc17__'] = [];
  notifications['__pjyc17__'].push(regNotif);
  saveNotifications();
  for (const [, s] of io.sockets.sockets) {
    if (s.user && s.user.id === 'pjyc17') {
      s.emit('registerNotify', regNotif);
    }
  }
  sendTeamsWebhook(`🆕 회원가입: ${name} (${dept}) / ID: ${id}`);
  res.json({ message: '회원가입 완료' });
});

app.post('/api/logout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) { sessions.delete(token); saveSessions(); }
  res.json({ ok: true });
});

// ── Microsoft OAuth 콜백 (공개) ──
app.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.send(`<h2>인증 실패</h2><p>${error}</p><script>setTimeout(()=>window.close(),3000)</script>`);
  if (!code || !state || !graph.validateState(state)) return res.send('<h2>잘못된 요청</h2>');
  try {
    const redirectUri = `https://${req.headers.host}/auth/callback`;
    await graph.exchangeCode(code, redirectUri);
    res.send('<html><body style="background:#0f172a;color:#22c55e;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;font-size:20px;">✓ Microsoft 연결 완료! 이 창을 닫아주세요.</body></html>');
  } catch (e) {
    res.send(`<h2>토큰 교환 실패</h2><p>${e.message}</p>`);
  }
});

// ── 관리자 API ──
app.get('/api/users', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = getUserByToken(token);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: '권한이 없습니다' });
  const list = Object.values(users).map(u => ({ id: u.id, name: u.name, dept: u.dept, role: u.role, createdAt: u.createdAt }));
  res.json(list);
});

app.post('/api/users', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = getUserByToken(token);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: '권한이 없습니다' });
  const { id, pw, name, dept } = req.body;
  if (!id || !pw || !name) return res.status(400).json({ error: 'ID, 비밀번호, 이름은 필수입니다' });
  if (users[id]) return res.status(400).json({ error: '이미 존재하는 ID입니다' });
  users[id] = { id, pw, name, dept: dept || '', role: 'user', createdAt: Date.now() };
  saveUsers();
  res.json({ message: `${name} 계정 생성 완료` });
});

app.delete('/api/users/:id', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = getUserByToken(token);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: '권한이 없습니다' });
  const targetId = req.params.id;
  if (targetId === 'admin') return res.status(400).json({ error: '관리자 계정은 삭제할 수 없습니다' });
  if (!users[targetId]) return res.status(404).json({ error: '존재하지 않는 계정입니다' });
  delete users[targetId];
  saveUsers();
  res.json({ message: '계정 삭제 완료' });
});

app.get('/api/clients', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = getUserByToken(token);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: '권한이 없습니다' });
  res.json(Array.from(connectedClients.values()));
});

app.get('/api/logs', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = getUserByToken(token);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: '권한이 없습니다' });
  const recent = logs.slice(-200).reverse();
  res.json(recent);
});

// ── 인증 미들웨어 (이후의 모든 API에 적용) ──
app.use('/api', (req, res, next) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const user = getUserByToken(token);
  if (!user) return res.status(401).json({ error: '로그인이 필요합니다' });
  req.user = user;
  next();
});

// ── Graph API 라우트 (pjyc17 전용) ──
function superOnly(req, res, next) {
  if (req.user && req.user.id === 'pjyc17') return next();
  return res.status(403).json({ error: '권한이 없습니다' });
}

app.get('/api/graph/config', superOnly, (req, res) => {
  const c = graph.loadConfig();
  res.json({ clientId: c.clientId || '', tenantId: c.tenantId || '', clientSecret: c.clientSecret ? '••••••' : '' });
});

app.post('/api/graph/config', superOnly, (req, res) => {
  const { clientId, tenantId, clientSecret } = req.body;
  if (!clientId || !tenantId || !clientSecret) return res.status(400).json({ error: '모든 항목을 입력해주세요' });
  let secret = clientSecret;
  if (clientSecret === '__keep__') {
    const existing = graph.loadConfig();
    secret = existing.clientSecret;
    if (!secret) return res.status(400).json({ error: 'Client Secret을 입력해주세요' });
  }
  graph.saveConfig({ clientId, tenantId, clientSecret: secret });
  graph.clearTokens();
  res.json({ message: '설정 저장 완료' });
});

app.get('/api/graph/login', superOnly, (req, res) => {
  if (!graph.isConfigured()) return res.status(400).json({ error: '먼저 앱 설정을 입력해주세요' });
  const redirectUri = `https://${req.headers.host}/auth/callback`;
  const { url } = graph.getAuthUrl(redirectUri);
  res.json({ url });
});

app.get('/api/graph/status', superOnly, async (req, res) => {
  const status = await graph.getStatus();
  res.json(status);
});

app.post('/api/graph/check-emails', superOnly, async (req, res) => {
  try {
    const result = await checkShippingEmails(req.user);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/graph/run-midnight', superOnly, async (req, res) => {
  try {
    const status = await graph.getStatus();
    if (status.connected) {
      await checkShippingEmails({ id: 'auto', name: '자동' }, '출하일정');
    }
  } catch (e) { console.error('  [수동자정] 메일체크 오류:', e.message); }
  clearCompletedEquipment();
  await applyMidnightSchedule();
  res.json({ message: '자정 스케줄 수동 실행 완료' });
});

app.post('/api/graph/disconnect', superOnly, (req, res) => {
  graph.clearTokens();
  res.json({ message: '연결 해제 완료' });
});

app.get('/api/webhook', superOnly, (req, res) => {
  const cfg = loadWebhook();
  res.json({ url: cfg.url || '' });
});
app.post('/api/webhook', superOnly, (req, res) => {
  const { url } = req.body;
  saveWebhook({ url: url || '' });
  res.json({ message: url ? '웹훅 저장 완료' : '웹훅 해제 완료' });
});
app.post('/api/webhook/test', superOnly, (req, res) => {
  sendTeamsWebhook('✅ 출하 Daily 웹훅 테스트 메시지');
  res.json({ message: '테스트 메시지 발송 완료' });
});

app.get('/vhwkd', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'vhwkd.html'));
});

app.use(express.static('public'));

const teams = ['산업품질1팀', '산업품질2팀', '제조혁신1&2팀'];

function createEmptyEquipment() {
  const eq = {};
  for (const lineName of LINE_NAMES) {
    const { start, end } = LINE_CONFIG[lineName];
    for (let i = start; i <= end; i++) {
      const id = `L${lineName}-E${i}`;
      eq[id] = {
        id,
        line: lineName,
        number: i,
        status: 'empty',
        equipName: null,
        lotNo: null,
        model: null,
        vendor: null,
        priority: null,
        team: null,
        since: null,
        receivedAt: null,
        shipDate: null,
        mfgInspected: false,
        fqcInspected: false,
      };
    }
  }
  return eq;
}

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      const base = createEmptyEquipment();
      for (const id of Object.keys(base)) {
        if (saved[id]) base[id] = saved[id];
      }
      const stageMigration = { parts_done: 'nt', nt_done: 'fqc', fqc_done: 'done' };
      for (const id of Object.keys(base)) {
        if (base[id].status === 'received') base[id].status = 'free';
        if (base[id].shipStage && stageMigration[base[id].shipStage]) {
          base[id].shipStage = stageMigration[base[id].shipStage];
        }
      }
      console.log('  저장된 데이터 로드 완료');
      return base;
    }
  } catch (err) {
    console.log('  저장 데이터 로드 실패, 초기 상태로 시작:', err.message);
  }
  return createEmptyEquipment();
}

let saveTimer = null;
function saveData() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    atomicWrite(DATA_FILE, equipment);
  }, 500);
}

const sampleData = [
  { line: 'D', number: 1,  lotNo: 'S2605056-1', model: 'KY8030-2XL',     vendor: '씨앤', priority: 9 },
  { line: 'K', number: 3,  lotNo: 'S2605059-1', model: 'KY8030-2XL',     vendor: '씨앤', priority: 10 },
  { line: 'D', number: 18, lotNo: 'S2606011-1', model: 'Zenith 2 (8Way)', vendor: '씨앤', priority: 1 },
  { line: 'E', number: 11, lotNo: 'S2606106-1', model: 'KY8030-3DL',     vendor: '씨앤', priority: 2 },
  { line: 'E', number: 1,  lotNo: 'S2606112-1', model: 'KY8030-3XL',     vendor: '씨앤', priority: 3 },
  { line: 'D', number: 2,  lotNo: 'S2606145-1', model: 'aSPIre 3L',      vendor: '씨앤', priority: 4 },
  { line: 'A', number: 9,  lotNo: 'S2606146-1', model: 'Zenith',         vendor: '씨앤', priority: 5 },
  { line: 'A', number: 10, lotNo: 'S2606147-1', model: 'Zenith',         vendor: '씨앤', priority: 6 },
  { line: 'B', number: 10, lotNo: 'S2606162-1', model: 'KY8080-2M',      vendor: '씨앤', priority: 7 },
  { line: 'C', number: 10, lotNo: 'S2606173-1', model: 'Zenith Nova',    vendor: '씨앤', priority: 8 },
];

const isFirstRun = !fs.existsSync(DATA_FILE);
const equipment = loadData();

if (isFirstRun) {
  for (const item of sampleData) {
    receiveEquipment(item.line, item.number, item, { id: 'system', name: '시스템' });
  }
  console.log(`  샘플 데이터 ${sampleData.length}건 로드 완료 (최초 실행)`);
}

function receiveEquipment(line, number, data, user) {
  const id = `L${line}-E${number}`;
  const eq = equipment[id];
  if (!eq) return null;
  eq.status = 'free';
  eq.equipName = data.model || data.equipName;
  eq.lotNo = data.lotNo || null;
  eq.model = data.model || null;
  eq.vendor = data.vendor || null;
  eq.priority = data.priority || null;
  eq.receivedAt = Date.now();
  eq.team = null;
  eq.since = null;
  io.emit('update', eq);
  saveData();
  addLog('receive', user?.id, user?.name, `${line}라인 ${number}번 입고 (${eq.equipName})`, { equipmentId: id, equipName: eq.equipName, line, slotNumber: number });
  io.emit('newLog');
  return eq;
}

app.post('/api/receive-bulk', (req, res) => {
  const items = req.body;
  if (!Array.isArray(items)) {
    return res.status(400).json({ error: '배열 형식으로 전달해주세요' });
  }
  const results = [];
  for (const item of items) {
    const eq = receiveEquipment(item.line, item.number, item, req.user);
    if (eq) results.push(eq.id);
  }
  res.json({ message: `${results.length}건 입고 완료`, ids: results });
});

app.post('/api/import-email', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text 필드가 필요합니다' });

  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  const results = [];

  for (const line of lines) {
    const parts = line.split(/\t+|\s{2,}/).map(p => p.trim()).filter(p => p);
    if (parts.length < 4) continue;

    const lineMatch = parts[0].match(/^([A-Z])-(\d+)$/);
    if (!lineMatch) continue;

    const lineName = lineMatch[1];
    const number = parseInt(lineMatch[2], 10);
    const lotNo = parts[1];
    const model = parts[2];
    const vendor = parts.length >= 5 ? parts[4] : null;
    const priority = parts.length >= 6 ? parseInt(parts[5], 10) : null;

    const eq = receiveEquipment(lineName, number, { lotNo, model, vendor, priority }, req.user);
    if (eq) results.push(eq.id);
  }

  res.json({ message: `${results.length}건 입고 완료`, ids: results });
});

function detectHeader(cols) {
  const map = {};
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (/tracking/i.test(c)) map.tracking = i;
    else if (/s.?n/i.test(c) && !('sn' in map)) map.sn = i;
    else if (/customer|고객/i.test(c)) map.customer = i;
    else if (/^line$/i.test(c) || /라인/i.test(c)) map.line = i;
    else if (/fqc/i.test(c)) map.fqc = i;
    else if (/선포장/.test(c)) map.prePack = i;
  }
  if (map.tracking !== undefined && map.line !== undefined && map.fqc !== undefined) return map;
  return null;
}

function parseShippingSchedule(text, shipDateOverride, opts) {
  const dryRun = opts && opts.dryRun;
  const rows = text.split('\n').map(l => l.trim()).filter(l => l);
  const results = { matched: [], unmatched: [], total: 0, parsed: [] };

  let headerMap = null;
  let dataStartIdx = 0;

  for (let i = 0; i < rows.length; i++) {
    const cols = rows[i].split('\t').map(c => c.trim());
    const detected = detectHeader(cols);
    if (detected) {
      headerMap = detected;
      dataStartIdx = i + 1;
      break;
    }
  }

  const dataRows = headerMap ? rows.slice(dataStartIdx) : rows;

  for (const row of dataRows) {
    const cols = row.split('\t').map(c => c.trim());
    if (cols.length < 5) continue;

    const firstCol = cols[0] || (headerMap && headerMap.tracking !== undefined ? cols[headerMap.tracking] : '');
    if (/^No\.?$/i.test(cols[0])) continue;
    if (!/^\d+$/.test(cols[0])) continue;

    let shipDate, trackingNo = '', modelName = '', lineSlot = null, fqcPerson = '', prePackaging = false, snName = '';

    if (headerMap) {
      shipDate = shipDateOverride ? new Date(shipDateOverride) : new Date();
      trackingNo = cols[headerMap.tracking] || '';
      modelName = headerMap.customer !== undefined ? (cols[headerMap.customer] || '') : '';
      snName = headerMap.sn !== undefined ? (cols[headerMap.sn] || '') : '';
      fqcPerson = cols[headerMap.fqc] || '';
      const lineCol = cols[headerMap.line] || '';
      const m = lineCol.match(/^([A-Z]{1,2})-(\d+)$/);
      if (m) lineSlot = { line: m[1], slot: parseInt(m[2], 10) };
      if (headerMap.prePack !== undefined) {
        prePackaging = (cols[headerMap.prePack] || '').toUpperCase() === 'O';
      }
    } else {
      shipDate = new Date(cols[1]);
      if (!isNaN(shipDate.getTime())) {
        modelName = cols[3] || '';
        trackingNo = cols[4] || '';
        const lineNo = cols.length > 8 ? cols[8] : '';
        if (lineNo) {
          const m = lineNo.match(/^([A-Z]{1,2})-?(\d+)$/);
          if (m) lineSlot = { line: m[1], slot: parseInt(m[2], 10) };
        }
      } else {
        shipDate = shipDateOverride ? new Date(shipDateOverride) : new Date();
        trackingNo = cols[1] || '';
        modelName = cols[3] || '';
        const lineCol = cols[4] || '';
        const m = lineCol.match(/^([A-Z]{1,2})-(\d+)$/);
        if (m) lineSlot = { line: m[1], slot: parseInt(m[2], 10) };
      }
    }

    results.total++;

    const parsedItem = { trackingNo, snName, modelName, fqcPerson, prePackaging, shipDate: shipDate.getTime(), lineSlot };
    results.parsed.push(parsedItem);

    if (dryRun) continue;

    let matchedEq = null;
    let matchMethod = '';

    if (lineSlot) {
      const eqId = `L${lineSlot.line}-E${lineSlot.slot}`;
      if (equipment[eqId]) {
        matchedEq = equipment[eqId];
        matchMethod = 'Line';
      }
    }

    if (!matchedEq && trackingNo) {
      const found = Object.values(equipment).find(
        eq => eq.status !== 'empty' && eq.lotNo && eq.lotNo === trackingNo
      );
      if (found) {
        matchedEq = found;
        matchMethod = 'Tracking No';
      }
    }

    if (matchedEq) {
      if (matchedEq.status === 'empty') {
        matchedEq.status = 'free';
        if (snName) matchedEq.equipName = snName;
        if (trackingNo) matchedEq.lotNo = trackingNo;
        if (modelName) matchedEq.vendor = modelName;
        matchedEq.receivedAt = Date.now();
      }
      matchedEq.shipDate = shipDate.getTime();
      matchedEq.shipStage = 'mail';
      if (fqcPerson) matchedEq.model = fqcPerson;
      matchedEq.prePackaging = prePackaging;
      io.emit('update', matchedEq);
      results.matched.push({
        slot: `${matchedEq.line}라인 ${matchedEq.number}번`,
        equipName: matchedEq.equipName || '-',
        trackingNo,
        shipDate: shipDate.toLocaleDateString('ko-KR'),
        matchMethod,
      });
    } else {
      results.unmatched.push({ trackingNo, modelName, lineNo: lineSlot ? `${lineSlot.line}-${lineSlot.slot}` : '-', shipDate: shipDate.toLocaleDateString('ko-KR') });
      if (!lineSlot) {
        pendingSlots.push({
          id: `pending-${Date.now()}-${results.unmatched.length}`,
          trackingNo: trackingNo || '',
          snName: snName || '',
          modelName: modelName || '',
          fqcPerson: fqcPerson || '',
          prePackaging,
          shipDate: shipDate.getTime(),
        });
      }
    }
  }

  if (!dryRun && results.matched.length > 0) saveData();
  if (!dryRun) io.emit('pendingUpdate', pendingSlots);
  return results;
}

function findKey(obj, keywords) {
  for (const k of Object.keys(obj)) {
    const lk = k.toLowerCase().replace(/[#＃\s]/g, '');
    if (keywords.some(kw => lk.includes(kw))) return k;
  }
  return null;
}

function enrichWithShipmentData(parsedItems, htmlBody) {
  const shipmentData = graph.parseShipmentTable(htmlBody);
  if (!shipmentData || !shipmentData.data.length) return;
  const sample = shipmentData.data[0];
  const trackingKey = findKey(sample, ['tracking']);
  const lineNoKey = findKey(sample, ['lineno', 'line']);
  const shipmentKey = findKey(sample, ['shipment']);
  if (!trackingKey) return;
  const lookup = {};
  for (const row of shipmentData.data) {
    const tracking = row[trackingKey] || '';
    if (!tracking) continue;
    lookup[tracking] = {
      lineNo: lineNoKey ? (row[lineNoKey] || '') : '',
      shipment: shipmentKey ? (row[shipmentKey] || '') : '',
    };
  }
  let corrected = 0;
  for (const item of parsedItems) {
    const info = lookup[item.trackingNo];
    if (!info) continue;
    item.shipment = info.shipment;
    const m = info.lineNo.match(/^([A-Z]{1,2})-?(\d+)$/);
    if (m) {
      const newSlot = { line: m[1], slot: parseInt(m[2], 10) };
      if (item.lineSlot && (item.lineSlot.line !== newSlot.line || item.lineSlot.slot !== newSlot.slot)) {
        console.log(`  [Shipment] Line 보정: ${item.trackingNo} ${item.lineSlot.line}-${item.lineSlot.slot} → ${newSlot.line}-${newSlot.slot}`);
        corrected++;
      }
      item.lineSlot = newSlot;
    }
  }
  if (corrected > 0) console.log(`  [Shipment] 총 ${corrected}건 Line 보정됨`);
}


app.post('/api/import-shipping-schedule', superOnly, (req, res) => {
  const { text, shipDate } = req.body;
  if (!text) return res.status(400).json({ error: '텍스트를 붙여넣기 해주세요' });
  const emailDate = shipDate ? new Date(shipDate) : null;

  // dryRun으로 파싱 → 선포장/일반 분리
  pendingSlots = [];
  const dryResults = parseShippingSchedule(text, emailDate, { dryRun: true });
  const allParsed = dryResults.parsed || [];
  const prepackItems = allParsed.filter(p => p.prePackaging);
  const normalItems = allParsed.filter(p => !p.prePackaging);

  // 기존 parsedSchedule 초기화 후 새로 저장
  saveParsedSchedule(null);
  parsedSchedule = { normal: normalItems, emailDate, tabText: text };
  saveParsedSchedule(parsedSchedule);

  // 선포장 장비만 즉시 배치
  const results = { matched: [], unmatched: [], total: allParsed.length, prepackCount: prepackItems.length, normalCount: normalItems.length };
  for (const item of prepackItems) {
    let matchedEq = null;
    if (item.lineSlot) {
      const eqId = `L${item.lineSlot.line}-E${item.lineSlot.slot}`;
      if (equipment[eqId]) matchedEq = equipment[eqId];
    }
    if (!matchedEq && item.trackingNo) {
      matchedEq = Object.values(equipment).find(eq => eq.status !== 'empty' && eq.lotNo && eq.lotNo === item.trackingNo) || null;
    }
    if (matchedEq) {
      if (matchedEq.status === 'empty') {
        matchedEq.status = 'free';
        if (item.snName) matchedEq.equipName = item.snName;
        if (item.trackingNo) matchedEq.lotNo = item.trackingNo;
        if (item.modelName) matchedEq.vendor = item.modelName;
        matchedEq.receivedAt = Date.now();
      }
      matchedEq.shipDate = item.shipDate;
      matchedEq.shipStage = 'mail';
      if (item.fqcPerson) matchedEq.model = item.fqcPerson;
      matchedEq.prePackaging = true;
      io.emit('update', matchedEq);
      results.matched.push({ slot: `${matchedEq.line}라인 ${matchedEq.number}번`, equipName: matchedEq.equipName || '-', trackingNo: item.trackingNo, prePackaging: true });
    } else {
      results.unmatched.push({ trackingNo: item.trackingNo, modelName: item.modelName, prePackaging: true });
      if (!item.lineSlot) {
        pendingSlots.push({ id: `pending-${Date.now()}-${pendingSlots.length+1}`, trackingNo: item.trackingNo||'', snName: item.snName||'', modelName: item.modelName||'', fqcPerson: item.fqcPerson||'', prePackaging: true, shipDate: item.shipDate });
      }
    }
  }
  if (results.matched.length > 0) saveData();
  io.emit('pendingUpdate', pendingSlots);

  addLog('schedule', req.user.id, req.user.name,
    `출하 일정 임포트: 선포장 ${prepackItems.length}건 즉시 배치, 일반 ${normalItems.length}건 자정 배치 예정`);
  io.emit('newLog');
  results.message = prepackItems.length > 0
    ? `선포장 ${results.matched.length}건 즉시 배치, 일반 ${normalItems.length}건 자정 배치 예정`
    : `선포장 없음, 전체 ${normalItems.length}건 자정 배치 예정`;
  res.json(results);
});

async function checkShippingEmails(user, keyword) {
  const emails = await graph.fetchShippingEmails(keyword);
  console.log(`  [Outlook] 검색 결과: ${emails.length}건`);
  emails.forEach((e, i) => console.log(`    ${i+1}. "${e.subject}" (${e.receivedDateTime})`));
  if (!emails.length) return { message: '출하검사 관련 메일을 찾을 수 없습니다 (최근 14일)', matched: [], unmatched: [] };

  const state = graph.loadState();
  const latest = emails[0];

  const isAuto = !user || user.id === 'auto';
  if (state.lastEmailId === latest.id && !isAuto) {
    return { message: '새로운 메일이 없습니다 (마지막 확인: ' + new Date(state.lastChecked).toLocaleString('ko-KR') + ')', matched: [], unmatched: [], skipped: true };
  }

  const emailInfo = {
    subject: latest.subject,
    from: latest.from?.emailAddress?.name || latest.from?.emailAddress?.address || '알 수 없음',
    receivedAt: latest.receivedDateTime,
  };
  console.log(`  [Outlook] 메일 발견: "${latest.subject}" (보낸사람: ${emailInfo.from}, ${latest.receivedDateTime})`);

  const htmlBody = latest.body?.content || '';
  const tabText = graph.parseHtmlTableToText(htmlBody);
  if (!tabText) {
    console.log(`  [Outlook] 표 파싱 실패 — HTML 길이: ${htmlBody.length}, <table> 포함: ${htmlBody.includes('<table')}`);
    return { message: `메일에서 표를 찾을 수 없습니다`, ...emailInfo, matched: [], unmatched: [], debugHtmlLength: htmlBody.length };
  }

  // 메일 제목에서 날짜 추출 (예: "2026/8/12 출하일정" → 2026-08-12)
  const dateMatch = latest.subject.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  const emailDate = dateMatch ? new Date(dateMatch[1], dateMatch[2] - 1, dateMatch[3]) : new Date(latest.receivedDateTime);

  // 자동 체크 시: 메일 날짜가 오늘 또는 내일이 아니면 건너뜀
  if (!user || user.id === 'auto' || user.id === 'prepack') {
    const today = new Date();
    today.setHours(0,0,0,0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const mailDay = new Date(emailDate);
    mailDay.setHours(0,0,0,0);
    if (mailDay.getTime() !== today.getTime() && mailDay.getTime() !== tomorrow.getTime()) {
      console.log(`  [자동체크] 메일 날짜(${mailDay.toLocaleDateString('ko-KR')})가 오늘/내일과 불일치 — 건너뜀`);
      return { message: `메일 날짜(${mailDay.toLocaleDateString('ko-KR')})가 오늘/내일과 맞지 않아 건너뜁니다`, matched: [], unmatched: [], skipped: true };
    }
  }

  // dryRun으로 파싱만 수행 (슬롯 배치 안 함)
  pendingSlots = [];
  const dryResults = parseShippingSchedule(tabText, emailDate, { dryRun: true });
  const allParsed = dryResults.parsed || [];

  // shipment 테이블로 Line 보정 + shipment 목적지 추가
  enrichWithShipmentData(allParsed, htmlBody);

  // 선포장 / 일반 분리
  const prepackItems = allParsed.filter(p => p.prePackaging);
  const normalItems = allParsed.filter(p => !p.prePackaging);

  console.log(`  [Outlook] 파싱 완료: 전체 ${allParsed.length}건 (선포장 ${prepackItems.length}건, 일반 ${normalItems.length}건)`);

  // 기존 parsedSchedule 초기화 후 새로 저장
  saveParsedSchedule(null);
  parsedSchedule = {
    normal: normalItems,
    emailDate,
    emailId: latest.id,
    subject: latest.subject,
    tabText,
  };
  saveParsedSchedule(parsedSchedule);

  // 선포장 장비 즉시 배치 (자정 auto 호출 시 건너뜀 — 이미 14:30에 배치됨)
  const results = { matched: [], unmatched: [], total: allParsed.length };
  if (prepackItems.length > 0 && user && user.id !== 'auto') {
    for (const item of prepackItems) {
      let matchedEq = null;
      if (item.lineSlot) {
        const eqId = `L${item.lineSlot.line}-E${item.lineSlot.slot}`;
        if (equipment[eqId]) matchedEq = equipment[eqId];
      }
      if (!matchedEq && item.trackingNo) {
        matchedEq = Object.values(equipment).find(eq => eq.status !== 'empty' && eq.lotNo && eq.lotNo === item.trackingNo) || null;
      }
      if (matchedEq) {
        if (matchedEq.status === 'empty' || matchedEq.shipCanceled) {
          matchedEq.status = 'free';
          matchedEq.shipCanceled = false; matchedEq.canceledAt = null;
          matchedEq.mfgInspected = false;
          matchedEq.fqcInspected = false;
          if (item.snName) matchedEq.equipName = item.snName;
          if (item.trackingNo) matchedEq.lotNo = item.trackingNo;
          if (item.modelName) matchedEq.vendor = item.modelName;
          matchedEq.receivedAt = Date.now();
        }
        matchedEq.shipDate = item.shipDate;
        matchedEq.shipStage = 'mail';
        if (item.fqcPerson) matchedEq.model = item.fqcPerson;
        if (item.shipment) matchedEq.shipment = item.shipment;
        matchedEq.prePackaging = true;
        io.emit('update', matchedEq);
        results.matched.push({
          slot: `${matchedEq.line}라인 ${matchedEq.number}번`,
          equipName: matchedEq.equipName || '-',
          trackingNo: item.trackingNo,
          shipDate: new Date(item.shipDate).toLocaleDateString('ko-KR'),
          matchMethod: item.lineSlot ? 'Line' : 'Tracking No',
          prePackaging: true,
        });
      } else {
        results.unmatched.push({ trackingNo: item.trackingNo, modelName: item.modelName, lineNo: item.lineSlot ? `${item.lineSlot.line}-${item.lineSlot.slot}` : '-', prePackaging: true });
        if (!item.lineSlot) {
          pendingSlots.push({
            id: `pending-${Date.now()}-${pendingSlots.length + 1}`,
            trackingNo: item.trackingNo || '',
            snName: item.snName || '',
            modelName: item.modelName || '',
            fqcPerson: item.fqcPerson || '',
            prePackaging: true,
            shipDate: item.shipDate,
            shipment: item.shipment || '',
          });
        }
      }
    }
    if (results.matched.length > 0) saveData();
    io.emit('pendingUpdate', pendingSlots);
  }

  const userName = user?.name || 'Outlook 자동';
  const userId = user?.id || 'outlook';
  if (prepackItems.length > 0 || normalItems.length > 0) {
    addLog('schedule', userId, userName,
      `Outlook 메일: 선포장 ${prepackItems.length}건 즉시 배치, 일반 ${normalItems.length}건 자정 배치 예정 (${latest.subject})`);
    io.emit('newLog');
  }

  graph.saveState({ lastChecked: Date.now(), lastEmailId: latest.id });
  results.subject = latest.subject;
  results.receivedAt = latest.receivedDateTime;
  results.prepackCount = prepackItems.length;
  results.normalCount = normalItems.length;
  results.message = prepackItems.length > 0
    ? `선포장 ${results.matched.length}건 즉시 배치, 일반 ${normalItems.length}건 자정 배치 예정`
    : `선포장 없음, 전체 ${normalItems.length}건 자정 배치 예정`;
  return results;
}

function clearCompletedEquipment() {
  const cleared = [];
  const expired = [];
  const stageLabels = { mail:'출하예정', parts:'생산관리완료', nt:'사전작업완료', fqc:'FQC완료', done:'출하완료' };
  const now = Date.now();
  const EXPIRE_DAYS = 4;

  for (const eq of Object.values(equipment)) {
    if (eq.status === 'empty' || eq.shipCanceled) continue;
    if (!eq.shipDate) continue;

    const daysPast = Math.floor((now - eq.shipDate) / 86400000);
    if (eq.shipStage === 'done' || (eq.shipStage === 'fqc' && eq.fqcInspected)) {
      cleared.push(`${eq.line}-${eq.number} (${eq.equipName || '-'}, ${stageLabels[eq.shipStage] || '?'})`);
    } else if (daysPast >= EXPIRE_DAYS) {
      expired.push(`${eq.line}-${eq.number} (${eq.equipName || '-'}, ${stageLabels[eq.shipStage] || '?'}, D+${daysPast})`);
    } else {
      continue;
    }

    eq.status = 'empty';
    eq.equipName = null;
    eq.lotNo = null;
    eq.model = null;
    eq.vendor = null;
    eq.priority = null;
    eq.team = null;
    eq.since = null;
    eq.receivedAt = null;
    eq.shipDate = null;
    eq.shipStage = null;
    eq.shipCanceled = false; eq.canceledAt = null;
    eq.prePackaging = false;
    eq.mfgInspected = false;
    eq.fqcInspected = false;
    eq.shipment = null;
    io.emit('update', eq);
  }

  if (cleared.length > 0 || expired.length > 0) saveData();
  if (cleared.length > 0) {
    addLog('schedule', 'auto', '자동', `출하 완료 장비 ${cleared.length}건 슬롯 초기화: ${cleared.join(', ')}`);
    console.log(`  [자정정리] 출하 완료 ${cleared.length}건 초기화: ${cleared.join(', ')}`);
  }
  if (expired.length > 0) {
    addLog('schedule', 'auto', '자동', `미완료 ${EXPIRE_DAYS}일 초과 ${expired.length}건 슬롯 초기화: ${expired.join(', ')}`);
    console.log(`  [자정정리] 미완료 ${EXPIRE_DAYS}일 초과 ${expired.length}건 초기화: ${expired.join(', ')}`);
  }
}

// ── 스크린샷 ──
const SNAPSHOT_DIR = path.join(__dirname, 'snapshots');
if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR);

function getLoginToken() {
  const user = users['pjyc17'];
  if (!user) return null;
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, 'pjyc17');
  saveSessions();
  return token;
}

async function takeScreenshot(filename) {
  const puppeteer = require('puppeteer-core');
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  let browser;
  try {
    const token = getLoginToken();
    if (!token) { console.error('  [스냅샷] 로그인 토큰 생성 실패'); return null; }

    browser = await puppeteer.launch({
      executablePath: edgePath,
      headless: 'new',
      args: ['--no-sandbox', '--ignore-certificate-errors', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });

    await page.evaluateOnNewDocument((t) => {
      localStorage.setItem('auth_token', t);
    }, token);

    await page.goto('https://localhost:3443/vhwkd.html', { waitUntil: 'networkidle0', timeout: 20000 });
    await new Promise(r => setTimeout(r, 3000));

    const filepath = path.join(SNAPSHOT_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: true });
    console.log(`  [스냅샷] ${filename} 저장 완료`);
    return filepath;
  } catch (e) {
    console.error(`  [스냅샷] 촬영 실패:`, e.message);
    return null;
  } finally {
    if (browser) await browser.close();
  }
}

async function sendSnapshotEmail(beforePath, afterPath) {
  try {
    const status = await graph.getStatus();
    if (!status.connected) { console.log('  [스냅샷] Graph API 미연결 — 메일 발송 건너뜀'); return; }
    const config = loadReportConfig();
    if (config.recipients.length === 0) { console.log('  [스냅샷] 수신자 없음'); return; }

    const attachments = [];
    if (beforePath && fs.existsSync(beforePath)) {
      attachments.push({ name: path.basename(beforePath), contentType: 'image/png', contentBytes: fs.readFileSync(beforePath).toString('base64') });
    }
    if (afterPath && fs.existsSync(afterPath)) {
      attachments.push({ name: path.basename(afterPath), contentType: 'image/png', contentBytes: fs.readFileSync(afterPath).toString('base64') });
    }
    if (attachments.length === 0) { console.log('  [스냅샷] 첨부 파일 없음'); return; }

    const d = new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const subject = `출하 Daily 자정 스냅샷 (${dateStr})`;
    const html = `<p>변경 전/후 보드 스냅샷입니다.</p><p>1. ${attachments[0]?.name || '-'} (변경 전)</p>${attachments[1] ? '<p>2. ' + attachments[1].name + ' (변경 후)</p>' : ''}`;
    await graph.sendMail(config.recipients, subject, html, attachments);
    console.log(`  [스냅샷] 메일 발송 완료 → ${config.recipients.join(', ')}`);
  } catch (e) {
    console.error(`  [스냅샷] 메일 발송 실패:`, e.message);
  }
}

// 자정: parsedSchedule의 일반 장비 배치 + 선포장 태그 제거
async function applyMidnightSchedule() {
  // 0-a. 변경 전 스크린샷
  const d0 = new Date();
  const dateTag = `${d0.getFullYear()}${String(d0.getMonth()+1).padStart(2,'0')}${String(d0.getDate()).padStart(2,'0')}`;
  let beforePath = null;
  try { beforePath = await takeScreenshot(`before-${dateTag}.png`); } catch (e) { console.error('  [자정] before 스크린샷 실패:', e.message); }

  // 0-b. 변경 전 JSON 스냅샷 저장 (shipDate가 있는 장비만)
  const snapshot = {};
  for (const [id, eq] of Object.entries(equipment)) {
    if (eq.shipDate) snapshot[id] = { ...eq };
  }
  if (Object.keys(snapshot).length > 0) {
    const d = new Date();
    const fname = `snapshot-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}.json`;
    const fpath = path.join(__dirname, fname);
    try { fs.writeFileSync(fpath, JSON.stringify(snapshot, null, 2)); console.log(`  [자정] 스냅샷 저장: ${fname} (${Object.keys(snapshot).length}건)`); }
    catch (e) { console.error(`  [자정] 스냅샷 저장 실패:`, e.message); }
  }

  // 1. parsedSchedule에 저장된 일반 장비 배치 (선포장 태그 제거보다 먼저)
  if (parsedSchedule && parsedSchedule.normal && parsedSchedule.normal.length > 0) {
    const items = parsedSchedule.normal;
    const matched = [];
    const unmatched = [];
    pendingSlots = [];

    // 기존 출하 데이터 정리 (선포장으로 이미 배치된 장비 제외)
    const stageLabels = { mail:'출하예정', parts:'생산관리완료', nt:'사전작업완료', fqc:'FQC완료', done:'출하완료' };
    const allItemNames = items.map(it => it.snName || it.trackingNo).filter(Boolean);
    const cleared = [];
    const incomplete = [];
    for (const eq of Object.values(equipment)) {
      if (eq.status === 'empty' || eq.shipCanceled) continue;
      if (!eq.shipDate) continue;
      if (eq.prePackaging) continue;
      const isInNewSchedule = allItemNames.some(name => name === eq.equipName || name === eq.lotNo);
      if (isInNewSchedule) continue;
      if (eq.shipStage === 'done') {
        cleared.push(`${eq.line}-${eq.number} (${eq.equipName || '-'})`);
        eq.status = 'empty'; eq.equipName = null; eq.lotNo = null; eq.model = null; eq.vendor = null;
        eq.priority = null; eq.team = null; eq.since = null; eq.receivedAt = null;
        eq.shipDate = null; eq.shipStage = null; eq.shipCanceled = false; eq.canceledAt = null; eq.prePackaging = false;
        eq.mfgInspected = false; eq.fqcInspected = false; eq.shipment = null;
      } else {
        const label = stageLabels[eq.shipStage] || '출하예정';
        incomplete.push(`${eq.line}-${eq.number} (${eq.equipName || '-'}, ${label})`);
        eq.shipDate = null; eq.shipStage = null; eq.shipCanceled = false; eq.canceledAt = null; eq.prePackaging = false; eq.shipment = null;
      }
      io.emit('update', eq);
    }
    if (cleared.length > 0) {
      addLog('schedule', 'auto', '자동', `출하 완료 장비 ${cleared.length}건 슬롯 초기화: ${cleared.join(', ')}`);
      console.log(`  [자정] 출하 완료 ${cleared.length}건 초기화`);
    }
    if (incomplete.length > 0) {
      addLog('schedule', 'auto', '자동', `출하 미완료 ${incomplete.length}건 초기화: ${incomplete.join(', ')}`);
      console.log(`  [자정] 미완료 ${incomplete.length}건 초기화`);
    }

    // 일반 장비 슬롯에 배치
    for (const item of items) {
      let matchedEq = null;
      if (item.lineSlot) {
        const eqId = `L${item.lineSlot.line}-E${item.lineSlot.slot}`;
        if (equipment[eqId]) matchedEq = equipment[eqId];
      }
      if (!matchedEq && item.trackingNo) {
        matchedEq = Object.values(equipment).find(eq => eq.status !== 'empty' && eq.lotNo && eq.lotNo === item.trackingNo) || null;
      }
      if (matchedEq) {
        if (matchedEq.status === 'empty' || matchedEq.shipCanceled) {
          matchedEq.status = 'free';
          matchedEq.shipCanceled = false; matchedEq.canceledAt = null;
          matchedEq.mfgInspected = false;
          matchedEq.fqcInspected = false;
          if (item.snName) matchedEq.equipName = item.snName;
          if (item.trackingNo) matchedEq.lotNo = item.trackingNo;
          if (item.modelName) matchedEq.vendor = item.modelName;
          matchedEq.receivedAt = Date.now();
        }
        matchedEq.shipDate = item.shipDate;
        matchedEq.shipStage = 'mail';
        if (item.fqcPerson) matchedEq.model = item.fqcPerson;
        if (item.shipment) matchedEq.shipment = item.shipment;
        matchedEq.prePackaging = false;
        io.emit('update', matchedEq);
        matched.push(`${matchedEq.line}-${matchedEq.number} (${matchedEq.equipName || '-'})`);
      } else {
        unmatched.push(item.trackingNo || item.snName || '-');
        if (!item.lineSlot) {
          pendingSlots.push({
            id: `pending-${Date.now()}-${pendingSlots.length + 1}`,
            trackingNo: item.trackingNo || '', snName: item.snName || '',
            modelName: item.modelName || '', fqcPerson: item.fqcPerson || '',
            prePackaging: false, shipDate: item.shipDate, shipment: item.shipment || '',
          });
        }
      }
    }
    if (matched.length > 0) saveData();
    io.emit('pendingUpdate', pendingSlots);
    addLog('schedule', 'auto', '자동', `자정 일반 장비 ${matched.length}건 배치, 미매칭 ${unmatched.length}건`);
    console.log(`  [자정] 일반 장비 ${matched.length}건 배치, 미매칭 ${unmatched.length}건`);
  } else {
    console.log('  [자정] 배치할 일반 장비 없음');
  }

  // 2. 이미 배치된 선포장 장비 → 태그만 제거, 상태 유지
  const untagged = [];
  for (const eq of Object.values(equipment)) {
    if (eq.prePackaging && eq.shipDate) {
      eq.prePackaging = false;
      untagged.push(`${eq.line}-${eq.number} (${eq.equipName || '-'})`);
      io.emit('update', eq);
    }
  }
  if (untagged.length > 0) {
    addLog('schedule', 'auto', '자동', `선포장 태그 제거 ${untagged.length}건: ${untagged.join(', ')}`);
    console.log(`  [자정] 선포장 태그 제거 ${untagged.length}건: ${untagged.join(', ')}`);
    saveData();
  }

  parsedSchedule = null;

  // 3. 변경 후 스크린샷 + 00:01에 메일 발송
  let afterPath = null;
  try { afterPath = await takeScreenshot(`after-${dateTag}.png`); } catch (e) { console.error('  [자정] after 스크린샷 실패:', e.message); }

  if (beforePath || afterPath) {
    const now = new Date();
    const send0001 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 1, 0);
    if (send0001 <= now) send0001.setDate(send0001.getDate() + 1);
    const emailDelay = Math.max(send0001 - now, 30000);
    console.log(`  [스냅샷] ${Math.round(emailDelay/1000)}초 후 메일 발송 예정`);
    setTimeout(() => sendSnapshotEmail(beforePath, afterPath), emailDelay);
  }
}

// 오후 2:30: 메일 자동 체크 → 선포장 장비만 즉시 배치, 일반은 자정 대기
function schedulePrepackCheck() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(14, 30, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target - now;
  console.log(`  [스케줄] 다음 선포장 체크: ${target.toLocaleString('ko-KR')} (${Math.round(delay/60000)}분 후)`);
  setTimeout(async () => {
    try {
      const status = await graph.getStatus();
      if (status.connected) {
        const result = await checkShippingEmails({ id: 'prepack', name: '선포장자동' }, '출하일정');
        if (result.skipped) {
          console.log(`  [14:30] ${result.message}`);
        } else {
          console.log(`  [14:30] 선포장 ${result.matched?.filter(m => m.prePackaging).length || 0}건 배치, 일반 자정 대기`);
        }
      } else {
        console.log('  [14:30] Graph API 미연결');
      }
    } catch (e) {
      console.error('  [14:30] 오류:', e.message);
    }
    schedulePrepackCheck();
  }, delay);
}

// 자정(00:00): 메일 더블체크 → 완료 정리 → 일반 장비 배치
function scheduleDailyCheck() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(0, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target - now;
  console.log(`  [스케줄] 다음 자정 체크: ${target.toLocaleString('ko-KR')} (${Math.round(delay/60000)}분 후)`);
  setTimeout(async () => {
    // 1. 메일 더블체크 — 14:30에 못 잡았을 경우 parsedSchedule 갱신
    try {
      const status = await graph.getStatus();
      if (status.connected) {
        const result = await checkShippingEmails({ id: 'auto', name: '자동' }, '출하일정');
        if (result.skipped) {
          console.log(`  [자정 메일체크] ${result.message}`);
        } else {
          console.log(`  [자정 메일체크] 선포장 ${result.prepackCount || 0}건, 일반 ${result.normalCount || 0}건`);
        }
      } else {
        console.log('  [자정 메일체크] Graph API 미연결');
      }
    } catch (e) {
      console.error('  [자정 메일체크] 오류:', e.message);
    }
    // 2. 완료 정리 + 로그 정리
    clearCompletedEquipment();
    cleanOldLogs();
    // 3. parsedSchedule 일반 장비 배치 + 선포장 태그 제거
    await applyMidnightSchedule();
    scheduleDailyCheck();
  }, delay);
}
scheduleDailyCheck();
schedulePrepackCheck();

// ── 리포트 자동 발송 스케줄러 ──
// 매일 7:25에 깨어나서, 해당 일에 맞는 리포트를 시차 발송
const REPORT_LABELS = { daily:'일간', weekly:'주간', monthly:'월간', quarterly:'분기', half:'반기', annual:'연간' };

function scheduleReportCheck() {
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 7, 25, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target.getTime() - Date.now();
  console.log(`  [리포트] 다음 체크: ${target.toLocaleString('ko-KR')} (${Math.round(delay / 60000)}분 후)`);

  setTimeout(() => {
    fireReports();
    scheduleReportCheck();
  }, delay);
}

function fireReports() {
  const now = new Date();
  const config = loadReportConfig();
  if (config.recipients.length === 0) {
    console.log('  [리포트] 수신자 없음 — 전체 건너뜀');
    return;
  }

  const toSend = [];
  toSend.push({ period: 'daily', delayMin: 5 });

  if (now.getDay() === 1) toSend.push({ period: 'weekly', delayMin: 7 });

  if (now.getDate() === 1) {
    toSend.push({ period: 'monthly', delayMin: 9 });
    if ([0, 3, 6, 9].includes(now.getMonth())) toSend.push({ period: 'quarterly', delayMin: 11 });
    if ([0, 6].includes(now.getMonth())) toSend.push({ period: 'half', delayMin: 13 });
    if (now.getMonth() === 0) toSend.push({ period: 'annual', delayMin: 15 });
  }

  console.log(`  [리포트] 오늘 발송: ${toSend.map(t => REPORT_LABELS[t.period]).join(', ')}`);

  for (const { period, delayMin } of toSend) {
    setTimeout(async () => {
      const label = REPORT_LABELS[period];
      try {
        const freshConfig = loadReportConfig();
        const report = buildReport(period);
        await graph.sendMail(freshConfig.recipients, report.subject, report.html);
        console.log(`  [리포트] ${label} 발송 완료 → ${freshConfig.recipients.join(', ')}`);
      } catch (e) {
        console.error(`  [리포트] ${label} 발송 실패:`, e.message);
      }
    }, delayMin * 60 * 1000);
  }
}

scheduleReportCheck();

app.get('/api/status', (req, res) => {
  res.json(equipment);
});

app.get('/api/stage-stats', (req, res) => {
  if (req.user?.id !== 'pjyc17') return res.status(403).json({ error: '권한 없음' });

  const stageOrder = ['출하예정','생산관리완료','사전작업완료','FQC완료','출하완료'];
  const stagePairs = [
    { from: '출하예정', to: '생산관리완료', label: '생산관리' },
    { from: '생산관리완료', to: '사전작업완료', label: '사전작업' },
    { from: '사전작업완료', to: 'FQC완료', label: 'FQC' },
    { from: 'FQC완료', to: '출하완료', label: '출하완료' },
  ];

  // equipmentId별로 stage 로그를 시간순 그룹핑
  const eqLogs = {};
  logs.forEach(l => {
    if (l.action !== 'stage' || !l.equipmentId || !l.detail) return;
    if (l.detail.includes('취소')) return;
    if (!eqLogs[l.equipmentId]) eqLogs[l.equipmentId] = [];
    eqLogs[l.equipmentId].push(l);
  });

  // 각 단계 전환별 소요시간 계산
  const transitions = {};
  stagePairs.forEach(p => { transitions[p.label] = []; });

  for (const eqId in eqLogs) {
    const entries = eqLogs[eqId].sort((a, b) => a.time - b.time);
    for (let i = 0; i < entries.length - 1; i++) {
      const cur = entries[i];
      const next = entries[i + 1];
      for (const p of stagePairs) {
        if (cur.detail.includes(p.from) && next.detail.includes(p.to)) {
          const mins = Math.round((next.time - cur.time) / 60000);
          if (mins >= 0 && mins < 14400) { // 10일 이내만 유효
            transitions[p.label].push({
              equipmentId: eqId,
              equipName: cur.equipName || '',
              userName: next.userName || '',
              minutes: mins,
              date: new Date(next.time).toLocaleDateString('ko-KR'),
            });
          }
        }
      }
    }
  }

  // 통계 집계
  const stats = {};
  for (const label in transitions) {
    const items = transitions[label];
    if (!items.length) { stats[label] = { count: 0, avg: 0, min: 0, max: 0, items: [] }; continue; }
    const mins = items.map(i => i.minutes);
    stats[label] = {
      count: items.length,
      avg: Math.round(mins.reduce((a, b) => a + b, 0) / mins.length),
      min: Math.min(...mins),
      max: Math.max(...mins),
      items: items.slice(-30).reverse(),
    };
  }
  res.json(stats);
});

app.get('/api/monthly-report', (req, res) => {
  if (req.user?.id !== 'pjyc17') return res.status(403).json({ error: '권한 없음' });

  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
  const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const stageKeys = {
    '생산관리완료': 'parts', '사전작업완료': 'nt',
    'FQC완료': 'fqc', '출하완료': 'done'
  };

  const stageLogs = logs.filter(l => l.action === 'stage' && l.detail && !l.detail.includes('취소'));

  // 1. 담당자별 일간/주간/월간
  const personStats = {};
  stageLogs.forEach(l => {
    const name = l.userName || '알 수 없음';
    if (!personStats[name]) personStats[name] = { daily:{}, weekly:{}, monthly:{} };
    const p = personStats[name];
    for (const label in stageKeys) {
      if (!l.detail.includes(label)) continue;
      const key = stageKeys[label];
      if (l.time >= todayStart.getTime()) p.daily[key] = (p.daily[key]||0) + 1;
      if (l.time >= weekStart.getTime()) p.weekly[key] = (p.weekly[key]||0) + 1;
      if (l.time >= monthStart.getTime()) p.monthly[key] = (p.monthly[key]||0) + 1;
    }
  });

  // 2. 월별 출하 완료 건수 (최근 6개월)
  const monthlyVolume = {};
  stageLogs.forEach(l => {
    if (!l.detail.includes('출하완료')) return;
    const d = new Date(l.time);
    const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
    monthlyVolume[key] = (monthlyVolume[key]||0) + 1;
  });

  // 최근 6개월 정렬 + 증감률
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
    const count = monthlyVolume[key] || 0;
    months.push({ month: key, count });
  }
  for (let i = 1; i < months.length; i++) {
    const prev = months[i-1].count;
    months[i].change = prev > 0 ? Math.round((months[i].count - prev) / prev * 100) : null;
  }

  // 3. 일별 출하 건수 (최근 30일)
  const dailyVolume = {};
  stageLogs.forEach(l => {
    if (!l.detail.includes('출하완료')) return;
    const d = new Date(l.time);
    const key = (d.getMonth()+1) + '/' + d.getDate();
    dailyVolume[key] = (dailyVolume[key]||0) + 1;
  });
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const key = (d.getMonth()+1) + '/' + d.getDate();
    days.push({ date: key, count: dailyVolume[key] || 0 });
  }

  res.json({ personStats, months, days });
});

function buildReport(period) {
  const PERIODS = {
    daily:    { label: '일간', days: 1,   prevLabel: '전일',   chartDays: 7,  trendMonths: 0 },
    weekly:   { label: '주간', days: 7,   prevLabel: '전주',   chartDays: 14, trendMonths: 0 },
    monthly:  { label: '월간', days: 30,  prevLabel: '전월',   chartDays: 30, trendMonths: 6 },
    quarterly:{ label: '분기', days: 90,  prevLabel: '전분기', chartDays: 0,  trendMonths: 6 },
    half:     { label: '반기', days: 180, prevLabel: '전반기', chartDays: 0,  trendMonths: 12 },
    annual:   { label: '연간', days: 365, prevLabel: '전년',   chartDays: 0,  trendMonths: 12 },
  };
  const cfg = PERIODS[period] || PERIODS.monthly;
  const now = new Date();

  const periodStart = new Date(now.getTime() - cfg.days * 86400000);
  const prevStart = new Date(periodStart.getTime() - cfg.days * 86400000);
  const stagePairs = [
    { from: '출하예정', to: '생산관리완료', label: '생산관리' },
    { from: '생산관리완료', to: '사전작업완료', label: '사전작업' },
    { from: '사전작업완료', to: 'FQC완료', label: 'FQC' },
    { from: 'FQC완료', to: '출하완료', label: '출하완료' },
  ];
  const stageKeys = { '생산관리완료':'parts', '사전작업완료':'nt', 'FQC완료':'fqc', '출하완료':'done' };
  const allStage = logs.filter(l => l.action === 'stage' && l.detail && !l.detail.includes('취소'));
  const allCancel = logs.filter(l => l.action === 'stage' && l.detail && l.detail.includes('취소'));
  const pStart = periodStart.getTime();
  const pPrev = prevStart.getTime();

  // 요약
  const donePeriod = allStage.filter(l => l.detail.includes('출하완료') && l.time >= pStart).length;
  const cancelPeriod = allCancel.filter(l => l.time >= pStart).length;
  const donePrev = allStage.filter(l => l.detail.includes('출하완료') && l.time >= pPrev && l.time < pStart).length;
  const changeRate = donePrev > 0 ? Math.round((donePeriod - donePrev) / donePrev * 100) : null;
  const cancelRate = donePeriod + cancelPeriod > 0 ? Math.round(cancelPeriod / (donePeriod + cancelPeriod) * 100) : null;

  // 납기
  let onTimeCount = 0, lateCount = 0, noDateCount = 0;
  const doneLogs = allStage.filter(l => l.detail.includes('출하완료') && l.time >= pStart);
  doneLogs.forEach(l => {
    const sd = l.shipDate || equipment[l.equipmentId]?.shipDate;
    if (sd) {
      Math.round((l.time - sd) / 86400000) <= 0 ? onTimeCount++ : lateCount++;
    } else { noDateCount++; }
  });
  const onTimeRate = onTimeCount + lateCount > 0 ? Math.round(onTimeCount / (onTimeCount + lateCount) * 100) : null;

  // 취소 장비 상세
  const cancelDetails = allCancel.filter(l => l.time >= pStart).map(l => {
    const m = l.detail.match(/(\S+?)라인 (\d+)번 출하 취소 \((.+?)\)/);
    return { time: l.time, line: m ? m[1] : '?', number: m ? m[2] : '?', name: m ? m[3] : (l.equipName || '-'), user: l.userName || '-' };
  });

  // 되돌림(롤백) 통계
  const revertLogs = logs.filter(l => l.action === 'stage' && l.detail && l.detail.includes('되돌림:') && l.time >= pStart);
  const revertByTransition = {};
  const revertByPerson = {};
  revertLogs.forEach(l => {
    const m = l.detail.match(/되돌림:(.+?)→(.+?)\s/);
    if (m) {
      const key = m[1] + ' → ' + m[2];
      if (!revertByTransition[key]) revertByTransition[key] = 0;
      revertByTransition[key]++;
    }
    const name = l.userName || '알 수 없음';
    revertByPerson[name] = (revertByPerson[name]||0) + 1;
  });

  // 소요시간
  const eqLogs = {};
  logs.forEach(l => {
    if (l.action !== 'stage' || !l.equipmentId || !l.detail || l.detail.includes('취소')) return;
    if (l.time < pStart) return;
    if (!eqLogs[l.equipmentId]) eqLogs[l.equipmentId] = [];
    eqLogs[l.equipmentId].push(l);
  });
  const transitions = {};
  stagePairs.forEach(p => { transitions[p.label] = []; });
  for (const eqId in eqLogs) {
    const entries = eqLogs[eqId].sort((a, b) => a.time - b.time);
    for (let i = 0; i < entries.length - 1; i++) {
      for (const p of stagePairs) {
        if (entries[i].detail.includes(p.from) && entries[i+1].detail.includes(p.to)) {
          const mins = Math.round((entries[i+1].time - entries[i].time) / 60000);
          if (mins >= 0 && mins < 14400) transitions[p.label].push({ minutes: mins });
        }
      }
    }
  }

  // 담당자별
  const personStats = {};
  allStage.filter(l => l.time >= pStart).forEach(l => {
    const name = l.userName || '알 수 없음';
    if (!personStats[name]) personStats[name] = {};
    for (const label in stageKeys) {
      if (!l.detail.includes(label)) continue;
      const key = stageKeys[label];
      personStats[name][key] = (personStats[name][key]||0) + 1;
    }
  });
  const sortedPersons = Object.keys(personStats).sort((a,b) => {
    const sum = p => (p.parts||0)+(p.nt||0)+(p.fqc||0)+(p.done||0);
    return sum(personStats[b]) - sum(personStats[a]);
  });

  // 라인별
  const lineStats = {};
  allStage.filter(l => l.time >= pStart && l.detail.includes('출하완료')).forEach(l => {
    const line = l.line || equipment[l.equipmentId]?.line || '?';
    if (!lineStats[line]) lineStats[line] = { done: 0, cancel: 0 };
    lineStats[line].done++;
  });
  allCancel.filter(l => l.time >= pStart).forEach(l => {
    const line = l.line || equipment[l.equipmentId]?.line || '?';
    if (!lineStats[line]) lineStats[line] = { done: 0, cancel: 0 };
    lineStats[line].cancel++;
  });

  // 일별 볼륨
  const dailyDone = {}, dailyCancel = {};
  allStage.filter(l => l.detail.includes('출하완료')).forEach(l => {
    const d = new Date(l.time);
    const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    dailyDone[key] = (dailyDone[key]||0) + 1;
  });
  allCancel.forEach(l => {
    const d = new Date(l.time);
    const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    dailyCancel[key] = (dailyCancel[key]||0) + 1;
  });

  // 월별 볼륨
  const monthlyDone = {}, monthlyCancel = {};
  allStage.filter(l => l.detail.includes('출하완료')).forEach(l => {
    const d = new Date(l.time);
    const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
    monthlyDone[key] = (monthlyDone[key]||0) + 1;
  });
  allCancel.forEach(l => {
    const d = new Date(l.time);
    const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
    monthlyCancel[key] = (monthlyCancel[key]||0) + 1;
  });

  // ── HTML 생성 ──
  const td = 'style="padding:5px 10px;border-bottom:1px solid #e2e8f0;"';
  const tdC = 'style="padding:5px 10px;border-bottom:1px solid #e2e8f0;text-align:center;"';
  const tdB = 'style="padding:5px 10px;border-bottom:1px solid #e2e8f0;text-align:center;font-weight:600;"';
  const thS = 'style="padding:6px 10px;text-align:center;border-bottom:2px solid #cbd5e1;font-size:12px;"';
  const thL = 'style="padding:6px 10px;text-align:left;border-bottom:2px solid #cbd5e1;font-size:12px;"';
  const sec = 'style="font-size:14px;margin:24px 0 8px 0;color:#334155;border-bottom:1px solid #e2e8f0;padding-bottom:6px;"';
  const BM = 160;
  function hBar(v, mx, c) {
    if (!v || !mx) return '';
    return `<div style="display:inline-block;width:${Math.max(2, Math.round(v/mx*BM))}px;height:14px;background:${c};border-radius:2px;vertical-align:middle;"></div> <span style="font-size:11px;color:${c};vertical-align:middle;">${v}</span>`;
  }
  const legend = `<div style="margin-bottom:6px;"><span style="display:inline-block;width:10px;height:10px;background:#2a78d6;border-radius:2px;margin-right:3px;vertical-align:middle;"></span><span style="font-size:11px;color:#64748b;margin-right:10px;">출하</span><span style="display:inline-block;width:10px;height:10px;background:#eb6834;border-radius:2px;margin-right:3px;vertical-align:middle;"></span><span style="font-size:11px;color:#64748b;">취소</span></div>`;
  const changeStr = changeRate !== null ? (changeRate > 0 ? '+' : '') + changeRate + '%' : null;

  const dateStr = now.getFullYear() + '.' + String(now.getMonth()+1).padStart(2,'0') + '.' + String(now.getDate()).padStart(2,'0');
  const periodLabel = { daily: dateStr, weekly: `${now.getFullYear()}년 ${Math.ceil((now.getTime() - new Date(now.getFullYear(),0,1).getTime()) / 604800000)}주차`, monthly: `${now.getFullYear()}년 ${now.getMonth()+1}월`, quarterly: `${now.getFullYear()}년 ${Math.ceil((now.getMonth()+1)/3)}분기`, half: `${now.getFullYear()}년 ${now.getMonth() < 6 ? '상' : '하'}반기`, annual: `${now.getFullYear()}년` }[period] || '';

  // 일별/월별 추이 차트
  let trendHtml = '';
  if (cfg.chartDays > 0) {
    const cDays = [];
    for (let i = cfg.chartDays - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      cDays.push({ label: String(d.getMonth()+1)+'/'+String(d.getDate()), done: dailyDone[key]||0, cancel: dailyCancel[key]||0 });
    }
    const cMax = Math.max(...cDays.map(d => Math.max(d.done, d.cancel)), 1);
    let rows = '';
    cDays.forEach(d => {
      rows += `<tr><td style="font-size:11px;color:#64748b;text-align:right;padding:2px 6px 2px 0;white-space:nowrap;width:40px;">${d.label}</td><td style="padding:2px 0;">`;
      if (d.done > 0 || d.cancel > 0) {
        if (d.done > 0) rows += hBar(d.done, cMax, '#2a78d6');
        if (d.cancel > 0) rows += `<br>${hBar(d.cancel, cMax, '#eb6834')}`;
      } else rows += '<span style="font-size:11px;color:#cbd5e1;">—</span>';
      rows += '</td></tr>';
    });
    trendHtml = `<h3 ${sec}>일별 출하 \xb7 취소 (최근 ${cfg.chartDays}일)</h3>${legend}<table style="width:100%;border-collapse:collapse;margin-bottom:16px;">${rows}</table>`;
  }
  if (cfg.trendMonths > 0) {
    const mList = [];
    for (let i = cfg.trendMonths - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
      mList.push({ month: key, done: monthlyDone[key]||0, cancel: monthlyCancel[key]||0 });
    }
    const mMax = Math.max(...mList.map(m => Math.max(m.done, m.cancel)), 1);
    let rows = '';
    mList.forEach((m,i) => {
      const prev = i > 0 ? mList[i-1].done : 0;
      const chg = prev > 0 ? Math.round((m.done - prev) / prev * 100) : null;
      const chgStr = chg !== null ? ` <span style="font-size:11px;color:${chg >= 0 ? '#16a34a' : '#dc2626'};">${chg > 0 ? '+' : ''}${chg}%</span>` : '';
      rows += `<tr><td style="font-size:12px;color:#64748b;text-align:right;padding:3px 8px 3px 0;white-space:nowrap;width:55px;">${m.month}</td><td style="padding:3px 0;">${hBar(m.done, mMax, '#2a78d6')}${m.cancel > 0 ? ' ' + hBar(m.cancel, mMax, '#eb6834') : ''}${chgStr}</td></tr>`;
    });
    trendHtml += `<h3 ${sec}>${cfg.trendMonths}개월 출하 추이</h3>${legend}<table style="width:100%;border-collapse:collapse;margin-bottom:16px;">${rows}</table>`;
  }

  // 소요시간 테이블
  let durRows = '';
  stagePairs.forEach(p => {
    const items = transitions[p.label];
    if (!items.length) { durRows += `<tr><td ${td}>${p.label}</td><td ${tdC}>0</td><td ${tdC}>-</td><td ${tdC}>-</td><td ${tdC}>-</td></tr>`; return; }
    const mins = items.map(i => i.minutes);
    const avg = Math.round(mins.reduce((a,b)=>a+b,0)/mins.length);
    durRows += `<tr><td ${td}>${p.label}</td><td ${tdC}>${items.length}</td><td ${tdB}>${avg}분</td><td ${tdC}>${Math.min(...mins)}분</td><td ${tdC}>${Math.max(...mins)}분</td></tr>`;
  });

  // 라인별
  const lineKeys = Object.keys(lineStats).sort();
  const lineMax = Math.max(...lineKeys.map(k => lineStats[k].done + lineStats[k].cancel), 1);
  let lineHtml = '';
  lineKeys.forEach(line => {
    const s = lineStats[line];
    lineHtml += `<tr><td style="font-size:12px;color:#334155;text-align:right;padding:3px 8px 3px 0;white-space:nowrap;width:30px;font-weight:600;">${line}</td><td style="padding:3px 0;">${hBar(s.done, lineMax, '#2a78d6')}${s.cancel > 0 ? ' ' + hBar(s.cancel, lineMax, '#eb6834') : ''}</td></tr>`;
  });

  // 담당자별 (상위 5)
  let personHtml = '';
  sortedPersons.slice(0, 5).forEach(name => {
    const p = personStats[name];
    const total = (p.parts||0)+(p.nt||0)+(p.fqc||0)+(p.done||0);
    if (total === 0) return;
    personHtml += `<tr><td ${td}>${name}</td><td ${tdC}>${p.parts||0}</td><td ${tdC}>${p.nt||0}</td><td ${tdC}>${p.fqc||0}</td><td ${tdC}>${p.done||0}</td><td ${tdB}>${total}</td></tr>`;
  });

  const subject = `출하 ${cfg.label} 리포트 — ${periodLabel}`;
  const html = `<div style="font-family:'Malgun Gothic','Segoe UI',sans-serif;max-width:620px;margin:0 auto;color:#1e293b;">
  <h2 style="font-size:18px;margin:0 0 20px 0;color:#0f172a;">출하 ${cfg.label} 리포트 — ${periodLabel}</h2>
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
    <tr>
      <td style="background:#f1f5f9;border-radius:8px;padding:14px 12px;text-align:center;">
        <div style="font-size:26px;font-weight:700;color:#0f172a;">${donePeriod}</div>
        <div style="font-size:11px;color:#64748b;">출하 완료</div>
        ${changeStr ? `<div style="font-size:11px;color:${changeRate >= 0 ? '#16a34a' : '#dc2626'};margin-top:2px;">${cfg.prevLabel} 대비 ${changeStr}</div>` : ''}
      </td>
      <td style="width:6px;"></td>
      <td style="background:#f1f5f9;border-radius:8px;padding:14px 12px;text-align:center;">
        <div style="font-size:26px;font-weight:700;color:#0f172a;">${cancelPeriod}</div>
        <div style="font-size:11px;color:#64748b;">취소${cancelRate !== null ? ' (' + cancelRate + '%)' : ''}</div>
      </td>
      <td style="width:6px;"></td>
      <td style="background:#f1f5f9;border-radius:8px;padding:14px 12px;text-align:center;">
        <div style="font-size:26px;font-weight:700;color:${onTimeRate !== null && onTimeRate < 80 ? '#dc2626' : '#0f172a'};">${onTimeRate !== null ? onTimeRate + '%' : '-'}</div>
        <div style="font-size:11px;color:#64748b;">납기 준수율</div>
      </td>
    </tr>
  </table>
  ${trendHtml}
  <h3 ${sec}>단계별 평균 소요시간</h3>
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px;">
    <tr style="background:#f8fafc;"><th ${thL}>단계</th><th ${thS}>건수</th><th ${thS}>평균</th><th ${thS}>최소</th><th ${thS}>최대</th></tr>${durRows}
  </table>
  <h3 ${sec}>라인별 출하 \xb7 취소</h3>${legend}
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">${lineHtml}</table>
  <h3 ${sec}>담당자별 ${cfg.label} 처리 (상위 5명)</h3>
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px;">
    <tr style="background:#f8fafc;"><th ${thL}>담당자</th><th ${thS}>생산관리</th><th ${thS}>사전작업</th><th ${thS}>FQC</th><th ${thS}>출하완료</th><th ${thS}>합계</th></tr>${personHtml}
  </table>
  <h3 ${sec}>납기 준수 현황</h3>
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:13px;">
    <tr><td ${td}>납기 준수</td><td ${tdB}>${onTimeCount}건</td><td style="padding:5px 10px;border-bottom:1px solid #e2e8f0;width:50%;">${hBar(onTimeCount, Math.max(onTimeCount, lateCount, 1), '#16a34a')}</td></tr>
    <tr><td ${td}>납기 지연</td><td ${tdB}>${lateCount}건</td><td style="padding:5px 10px;border-bottom:1px solid #e2e8f0;">${hBar(lateCount, Math.max(onTimeCount, lateCount, 1), '#dc2626')}</td></tr>
    <tr><td ${td}>예정일 없음</td><td ${tdB}>${noDateCount}건</td><td style="padding:5px 10px;border-bottom:1px solid #e2e8f0;font-size:11px;color:#94a3b8;">출하예정일 미등록</td></tr>
  </table>
  ${cancelDetails.length > 0 ? `
  <h3 ${sec}>출하 취소 목록 (${cancelDetails.length}건)</h3>
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px;">
    <tr style="background:#f8fafc;"><th ${thL}>장비</th><th ${thS}>라인</th><th ${thS}>취소자</th><th ${thS}>일시</th></tr>
    ${cancelDetails.map(c => {
      const dt = new Date(c.time);
      const ts = (dt.getMonth()+1)+'/'+dt.getDate()+' '+String(dt.getHours()).padStart(2,'0')+':'+String(dt.getMinutes()).padStart(2,'0');
      return `<tr><td ${td}>${c.name}</td><td ${tdC}>${c.line}-${c.number}</td><td ${tdC}>${c.user}</td><td ${tdC}>${ts}</td></tr>`;
    }).join('')}
  </table>
  ` : ''}
  ${revertLogs.length > 0 ? `
  <h3 ${sec}>되돌림 현황 (${revertLogs.length}건)</h3>
  <table style="width:100%;border-collapse:collapse;margin-bottom:8px;font-size:13px;">
    <tr style="background:#f8fafc;"><th ${thL}>구간</th><th ${thS}>횟수</th><th style="padding:6px 10px;border-bottom:2px solid #cbd5e1;font-size:12px;width:50%;"></th></tr>
    ${Object.entries(revertByTransition).sort((a,b)=>b[1]-a[1]).map(([k,v]) => `<tr><td ${td}>${k}</td><td ${tdB}>${v}</td><td style="padding:5px 10px;border-bottom:1px solid #e2e8f0;">${hBar(v, Math.max(...Object.values(revertByTransition)), '#9333ea')}</td></tr>`).join('')}
  </table>
  <table style="width:100%;border-collapse:collapse;margin-bottom:16px;font-size:13px;">
    <tr style="background:#f8fafc;"><th ${thL}>담당자</th><th ${thS}>되돌림 횟수</th><th style="padding:6px 10px;border-bottom:2px solid #cbd5e1;font-size:12px;width:50%;"></th></tr>
    ${Object.entries(revertByPerson).sort((a,b)=>b[1]-a[1]).map(([k,v]) => `<tr><td ${td}>${k}</td><td ${tdB}>${v}</td><td style="padding:5px 10px;border-bottom:1px solid #e2e8f0;">${hBar(v, Math.max(...Object.values(revertByPerson)), '#9333ea')}</td></tr>`).join('')}
  </table>
  ` : ''}
  <p style="color:#94a3b8;font-size:11px;margin:0;text-align:center;">출하 Daily 자동 생성 · ${cfg.label} 리포트</p>
</div>`;

  return { subject, html, period: cfg.label, periodLabel };
}

app.get('/api/report-recipients', superOnly, (req, res) => {
  res.json(loadReportConfig().recipients);
});

app.post('/api/report-recipients', superOnly, (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: '이메일 필요' });
  const config = loadReportConfig();
  if (!config.recipients.includes(email)) {
    config.recipients.push(email);
    saveReportConfig(config);
  }
  res.json({ recipients: config.recipients, message: `${email} 추가됨` });
});

app.delete('/api/report-recipients', superOnly, (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: '이메일 필요' });
  const config = loadReportConfig();
  config.recipients = config.recipients.filter(r => r !== email);
  saveReportConfig(config);
  res.json({ recipients: config.recipients, message: `${email} 삭제됨` });
});

app.post('/api/send-report', async (req, res) => {
  if (req.user?.id !== 'pjyc17') return res.status(403).json({ error: '권한 없음' });
  const { to, period } = req.body;
  if (!to) return res.status(400).json({ error: '수신자 이메일 필요' });

  const p = period || 'monthly';
  const validPeriods = ['daily','weekly','monthly','quarterly','half','annual'];
  if (!validPeriods.includes(p)) return res.status(400).json({ error: '유효한 주기: ' + validPeriods.join(', ') });

  const report = buildReport(p);

  try {
    await graph.sendMail(to, report.subject, report.html);
    res.json({ message: `${report.period} 리포트 메일 발송 완료 (${report.periodLabel})` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ship-history/:equipmentId', (req, res) => {
  const eqId = req.params.equipmentId;
  const result = logs
    .filter(l => l.action === 'stage' && l.equipmentId === eqId)
    .slice(-20)
    .reverse();
  res.json(result);
});

function parseDetailForEquipment(detail) {
  const m = detail.match(/^([A-Z]{1,2})라인\s+(\d+)번/);
  if (!m) return null;
  return { line: m[1], slotNumber: parseInt(m[2], 10), equipmentId: `L${m[1]}-E${m[2]}` };
}

app.get('/api/history/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const lowerQ = q.toLowerCase();
  const eqMatches = Object.values(equipment).filter(eq => {
    if (eq.status === 'empty') return false;
    if (eq.equipName && eq.equipName.toLowerCase().includes(lowerQ)) return true;
    if (eq.lotNo && eq.lotNo.toLowerCase().includes(lowerQ)) return true;
    if (eq.model && eq.model.toLowerCase().includes(lowerQ)) return true;
    return false;
  }).map(eq => eq.id);
  const matched = logs.filter(l => {
    if (!['receive', 'release', 'checkin', 'checkout'].includes(l.action)) return false;
    if (l.equipName && l.equipName.toLowerCase().includes(lowerQ)) return true;
    if (l.detail && l.detail.toLowerCase().includes(lowerQ)) return true;
    if (l.equipmentId && eqMatches.includes(l.equipmentId)) return true;
    return false;
  });
  const grouped = {};
  for (const log of matched) {
    const eqId = log.equipmentId || parseDetailForEquipment(log.detail)?.equipmentId || 'unknown';
    if (!grouped[eqId]) grouped[eqId] = [];
    grouped[eqId].push(log);
  }
  res.json(grouped);
});

app.get('/api/history/:equipmentId', (req, res) => {
  const eqId = req.params.equipmentId;
  const parsed = eqId.match(/^L([A-Z]{1,2})-E(\d+)$/);
  const result = logs.filter(l => {
    if (!['receive', 'release', 'checkin', 'checkout', 'stage', 'schedule'].includes(l.action)) return false;
    if (l.equipmentId === eqId) return true;
    if (!l.equipmentId && parsed) {
      const info = parseDetailForEquipment(l.detail || '');
      if (info && info.line === parsed[1] && info.slotNumber === parseInt(parsed[2], 10)) return true;
    }
    return false;
  });
  res.json(result);
});

const connectedClients = new Map();

io.on('connection', (socket) => {
  const req = socket.request;
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || '';
  const ua = req.headers['user-agent'] || '';
  const token = socket.handshake.auth?.token;
  const user = getUserByToken(token);

  if (!user) {
    socket.disconnect();
    return;
  }

  connectedClients.set(socket.id, {
    ip: ip.replace('::ffff:', ''),
    userAgent: ua,
    userName: user.name,
    userDept: user.dept,
    userId: user.id,
    connectedAt: Date.now(),
  });
  io.emit('clientCount', connectedClients.size);

  socket.on('disconnect', () => {
    connectedClients.delete(socket.id);
    io.emit('clientCount', connectedClients.size);
  });

  socket.user = user;
  socket.emit('init', { equipment, teams, lineNames: LINE_NAMES, lineConfig: LINE_CONFIG, pendingSlots, cameras });

  const userNotifs = notifications[user.name] || [];
  if (userNotifs.length > 0) {
    userNotifs.forEach(n => socket.emit('fqcNotify', n));
  }
  if (user.id === 'pjyc17') {
    const pNotifs = notifications['__pjyc17__'] || [];
    pNotifs.forEach(n => socket.emit('registerNotify', n));
  }

  socket.on('dismissNotif', (notifId) => {
    if (notifications[user.name]) {
      notifications[user.name] = notifications[user.name].filter(n => n.id !== notifId);
      if (notifications[user.name].length === 0) delete notifications[user.name];
    }
    if (user.id === 'pjyc17' && notifications['__pjyc17__']) {
      notifications['__pjyc17__'] = notifications['__pjyc17__'].filter(n => n.id !== notifId);
      if (notifications['__pjyc17__'].length === 0) delete notifications['__pjyc17__'];
    }
    saveNotifications();
  });

  socket.on('receive', ({ equipmentId, equipName }) => {
    const eq = equipment[equipmentId];
    if (!eq) return;
    eq.status = 'free';
    eq.equipName = equipName;
    eq.model = equipName;
    eq.receivedAt = Date.now();
    eq.team = null;
    eq.since = null;
    io.emit('update', eq);
    saveData();
    const u = socket.user;
    addLog('receive', u?.id, u?.name, `${eq.line}라인 ${eq.number}번 입고 (${equipName})`, { equipmentId: eq.id, equipName, line: eq.line, slotNumber: eq.number });
    io.emit('newLog');
  });

  socket.on('release', ({ equipmentId }) => {
    const eq = equipment[equipmentId];
    if (!eq) return;
    const prevName = eq.equipName;
    eq.status = 'empty';
    eq.equipName = null;
    eq.lotNo = null;
    eq.model = null;
    eq.vendor = null;
    eq.priority = null;
    eq.team = null;
    eq.since = null;
    eq.receivedAt = null;
    eq.shipDate = null;
    eq.shipStage = null;
    eq.shipCanceled = false; eq.canceledAt = null;
    eq.prePackaging = false;
    eq.mfgInspected = false;
    eq.fqcInspected = false;
    eq.shipment = null;
    io.emit('update', eq);
    saveData();
    const u = socket.user;
    addLog('release', u?.id, u?.name, `${eq.line}라인 ${eq.number}번 출고 (${prevName})`, { equipmentId: eq.id, equipName: prevName, line: eq.line, slotNumber: eq.number });
    io.emit('newLog');
  });

  socket.on('checkin', ({ equipmentId, team }) => {
    const eq = equipment[equipmentId];
    if (!eq || eq.status === 'empty') return;
    eq.status = 'occupied';
    eq.team = team;
    eq.since = Date.now();
    io.emit('update', eq);
    saveData();
    const u = socket.user;
    addLog('checkin', u?.id, u?.name, `${eq.line}라인 ${eq.number}번 체크인 (${team}, ${eq.equipName})`, { equipmentId: eq.id, equipName: eq.equipName, line: eq.line, slotNumber: eq.number });
    io.emit('newLog');
  });

  socket.on('checkout', ({ equipmentId }) => {
    const eq = equipment[equipmentId];
    if (!eq) return;
    eq.status = 'free';
    eq.team = null;
    eq.since = null;
    io.emit('update', eq);
    saveData();
    const u = socket.user;
    addLog('checkout', u?.id, u?.name, `${eq.line}라인 ${eq.number}번 체크아웃 (${eq.equipName})`, { equipmentId: eq.id, equipName: eq.equipName, line: eq.line, slotNumber: eq.number });
    io.emit('newLog');
  });

  socket.on('setShipDate', ({ equipmentId, shipDate }) => {
    const eq = equipment[equipmentId];
    if (!eq || eq.status === 'empty') return;
    eq.shipDate = shipDate;
    eq.shipStage = eq.shipStage || 'mail';
    eq.shipCanceled = false; eq.canceledAt = null;
    io.emit('update', eq);
    saveData();
    const u = socket.user;
    const dateStr = new Date(shipDate).toLocaleDateString('ko-KR');
    addLog('shipdate', u?.id, u?.name, `${eq.line}라인 ${eq.number}번 출고 예정일 설정 (${dateStr}, ${eq.equipName})`, { equipmentId: eq.id, equipName: eq.equipName, line: eq.line, slotNumber: eq.number });
    io.emit('newLog');
  });

  const VALID_STAGES = ['mail','parts','nt','fqc','done'];
  const STAGE_ORDER = {mail:0, parts:1, nt:2, fqc:3, done:4};
  const REVERT_PERM = {parts:'생산관리', nt:'엔티', fqc:'산업품질2팀'};
  socket.on('setShipStage', ({ equipmentId, stage }) => {
    const eq = equipment[equipmentId];
    if (!eq || !eq.shipDate) return;
    if (!VALID_STAGES.includes(stage)) return;
    const prev = eq.shipStage;
    const u = socket.user;
    const dept = u?.dept || '';
    const role = u?.role || '';
    const isSuper = role === 'admin' || u?.id === 'pjyc17';
    const isRevert = STAGE_ORDER[stage] < STAGE_ORDER[prev];
    if (dept === 'ship' && !isSuper) {
      if (isRevert || prev !== 'fqc') return;
    } else if (isRevert) {
      if (!isSuper && dept !== '산업품질2팀' && REVERT_PERM[prev] !== dept) return;
    } else {
      const FQC_BLOCKED = ['생산관리', '엔티'];
      if ((prev === 'nt' || prev === 'fqc') && FQC_BLOCKED.includes(dept) && !isSuper) return;
      if (prev === 'parts' && dept === '생산관리' && !isSuper) return;
      if (prev === 'mail' && dept === '엔티' && !isSuper) return;
    }
    eq.shipStage = stage;
    io.emit('update', eq);
    saveData();
    const stageLabels = {mail:'출하예정',parts:'생산관리완료',nt:'사전작업완료',fqc:'FQC완료',done:'출하완료'};
    const detail = isRevert
      ? `${eq.line}라인 ${eq.number}번 되돌림:${stageLabels[prev]}→${stageLabels[stage]} (${eq.equipName})`
      : `${eq.line}라인 ${eq.number}번 ${stageLabels[stage]} (${eq.equipName})`;
    addLog('stage', u?.id, u?.name, detail, { equipmentId: eq.id, equipName: eq.equipName, line: eq.line, slotNumber: eq.number, shipDate: eq.shipDate });
    io.emit('newLog');

    if (stage === 'nt' && eq.model) {
      const fqcName = eq.model.trim();
      const notif = {
        id: Date.now() + '_' + eq.id,
        equipmentId: eq.id,
        line: eq.line,
        number: eq.number,
        equipName: eq.equipName || '',
        lotNo: eq.lotNo || '',
        vendor: eq.vendor || '',
        createdAt: Date.now(),
      };
      if (!notifications[fqcName]) notifications[fqcName] = [];
      notifications[fqcName].push(notif);
      saveNotifications();
      for (const [sid, client] of connectedClients) {
        if (client.userName === fqcName) {
          io.to(sid).emit('fqcNotify', notif);
        }
      }
    }

    if (stage === 'fqc' && eq.model) {
      const fqcName = eq.model.trim();
      if (notifications[fqcName]) {
        const removed = notifications[fqcName].filter(n => n.equipmentId === equipmentId);
        notifications[fqcName] = notifications[fqcName].filter(n => n.equipmentId !== equipmentId);
        if (notifications[fqcName].length === 0) delete notifications[fqcName];
        saveNotifications();
        removed.forEach(n => {
          for (const [sid, client] of connectedClients) {
            if (client.userName === fqcName) {
              io.to(sid).emit('removeNotif', n.id);
            }
          }
        });
      }
    }
  });

  socket.on('cancelShipment', (data, ack) => {
    console.log('[cancelShipment] 수신:', data, 'ack:', typeof ack);
    try {
      const { equipmentId, password } = data || {};
      const u = socket.user;
      if (!u) { console.log('[cancelShipment] 유저 없음'); if (ack) ack({ error: '인증 필요' }); return; }
      const users = loadUsers();
      const user = users[u.id];
      if (!user || user.pw !== password) { console.log('[cancelShipment] 비번 틀림'); if (ack) ack({ error: '비밀번호가 틀렸습니다' }); return; }
      const eq = equipment[equipmentId];
      if (!eq || !eq.shipDate) { console.log('[cancelShipment] 장비 없음:', equipmentId); if (ack) ack({ error: '해당 장비 없음' }); return; }
      if (user.dept !== '산업품질2팀' && u.id !== 'pjyc17') { if (ack) ack({ error: 'FQC 소속만 출하 취소가 가능합니다' }); return; }
      const prevName = eq.equipName;
      eq.shipDate = null;
      eq.shipStage = null;
      eq.shipCanceled = true;
      eq.canceledAt = Date.now();
      io.emit('update', eq);
      saveData();
      addLog('stage', u.id, u.name, `${eq.line}라인 ${eq.number}번 출하 취소 (${prevName})`, { equipmentId: eq.id, equipName: prevName, line: eq.line, slotNumber: eq.number });
      io.emit('newLog');
      console.log('[cancelShipment] 성공');
      if (ack) ack({ ok: true });
    } catch (e) {
      console.error('[cancelShipment] 에러:', e);
      if (ack) ack({ error: '서버 오류' });
    }
  });

  socket.on('restoreShipment', (data, ack) => {
    try {
      const { equipmentId, password } = data || {};
      const u = socket.user;
      if (!u) { if (ack) ack({ error: '인증 필요' }); return; }
      const users = loadUsers();
      const user = users[u.id];
      if (!user || user.pw !== password) { if (ack) ack({ error: '비밀번호가 틀렸습니다' }); return; }
      const eq = equipment[equipmentId];
      if (!eq || !eq.shipCanceled) { if (ack) ack({ error: '해당 장비 없음' }); return; }
      if (user.dept !== '산업품질2팀' && u.id !== 'pjyc17') { if (ack) ack({ error: 'FQC 소속만 취소 복원이 가능합니다' }); return; }
      eq.shipDate = Date.now();
      eq.shipStage = 'mail';
      eq.shipCanceled = false; eq.canceledAt = null;
      io.emit('update', eq);
      saveData();
      addLog('stage', u.id, u.name, `${eq.line}라인 ${eq.number}번 출하 취소 복원 (${eq.equipName})`, { equipmentId: eq.id, equipName: eq.equipName, line: eq.line, slotNumber: eq.number });
      io.emit('newLog');
      if (ack) ack({ ok: true });
    } catch (e) {
      if (ack) ack({ error: '서버 오류' });
    }
  });

  socket.on('inspect', ({ equipmentId, type }) => {
    const eq = equipment[equipmentId];
    if (!eq || eq.status === 'empty') return;
    if (type === 'mfg') eq.mfgInspected = !eq.mfgInspected;
    if (type === 'fqc') eq.fqcInspected = !eq.fqcInspected;
    io.emit('update', eq);
    saveData();
    const u = socket.user;
    const label = type === 'mfg' ? '제조팀' : 'FQC';
    const status = (type === 'mfg' ? eq.mfgInspected : eq.fqcInspected) ? '완료' : '취소';
    addLog('inspect', u?.id, u?.name, `${eq.line}라인 ${eq.number}번 ${label} 검수 ${status} (${eq.equipName})`, { equipmentId: eq.id, equipName: eq.equipName, line: eq.line, slotNumber: eq.number });
    io.emit('newLog');
  });

  // 슬롯 이동
  socket.on('moveEquipment', (data, ack) => {
    try {
      const { fromId, toId, password } = data || {};
      const u = socket.user;
      if (!u) { if (ack) ack({ error: '인증 필요' }); return; }
      const users = loadUsers();
      const user = users[u.id];
      if (!user || user.pw !== password) { if (ack) ack({ error: '비밀번호가 틀렸습니다' }); return; }
      if (user.dept !== '산업품질2팀' && u.id !== 'pjyc17') { if (ack) ack({ error: '권한이 없습니다' }); return; }
      const from = equipment[fromId];
      const to = equipment[toId];
      if (!from || !to) { if (ack) ack({ error: '슬롯을 찾을 수 없습니다' }); return; }
      if (from.status === 'empty' || !from.shipDate) { if (ack) ack({ error: '이동할 출하 장비가 없습니다' }); return; }
      if (to.status !== 'empty') { if (ack) ack({ error: '대상 슬롯이 비어있지 않습니다' }); return; }
      const prevName = from.equipName;
      to.status = from.status; to.equipName = from.equipName; to.lotNo = from.lotNo;
      to.model = from.model; to.vendor = from.vendor; to.priority = from.priority;
      to.team = from.team; to.since = from.since; to.receivedAt = from.receivedAt;
      to.shipDate = from.shipDate; to.shipStage = from.shipStage; to.shipCanceled = from.shipCanceled;
      to.prePackaging = from.prePackaging; to.mfgInspected = from.mfgInspected; to.fqcInspected = from.fqcInspected;
      from.status = 'empty'; from.equipName = null; from.lotNo = null; from.model = null;
      from.vendor = null; from.priority = null; from.team = null; from.since = null;
      from.receivedAt = null; from.shipDate = null; from.shipStage = null; from.shipCanceled = false;
      from.prePackaging = false; from.mfgInspected = false; from.fqcInspected = false;
      // 장비 이력을 새 슬롯으로 이동 (단계 전환/스케줄 이력만, 이동/비우기 이력은 슬롯에 남김)
      for (const entry of logs) {
        if (entry.equipmentId === fromId && ['stage', 'schedule'].includes(entry.action)) {
          if (entry.detail && (entry.detail.includes('이동') || entry.detail.includes('비우기'))) continue;
          entry.equipmentId = toId;
          entry.line = to.line;
          entry.slotNumber = to.number;
        }
      }
      io.emit('update', from); io.emit('update', to);
      saveData();
      addLog('stage', u.id, u.name, `${to.line}라인 ${to.number}번으로 이동 (${prevName})`, { equipmentId: fromId, equipName: prevName, line: from.line, slotNumber: from.number });
      addLog('stage', u.id, u.name, `${from.line}라인 ${from.number}번에서 이동 (${prevName})`, { equipmentId: toId, equipName: prevName, line: to.line, slotNumber: to.number });
      io.emit('newLog');
      if (ack) ack({ ok: true });
    } catch (e) { if (ack) ack({ error: '서버 오류' }); }
  });

  // 슬롯 비우기
  socket.on('clearSlot', (data, ack) => {
    try {
      const { equipmentId, password } = data || {};
      const u = socket.user;
      if (!u) { if (ack) ack({ error: '인증 필요' }); return; }
      const users = loadUsers();
      const user = users[u.id];
      if (!user || user.pw !== password) { if (ack) ack({ error: '비밀번호가 틀렸습니다' }); return; }
      if (user.dept !== '산업품질2팀' && u.id !== 'pjyc17') { if (ack) ack({ error: '권한이 없습니다' }); return; }
      const eq = equipment[equipmentId];
      if (!eq || eq.status === 'empty') { if (ack) ack({ error: '이미 비어있습니다' }); return; }
      const prevName = eq.equipName;
      eq.status = 'empty'; eq.equipName = null; eq.lotNo = null; eq.model = null;
      eq.vendor = null; eq.priority = null; eq.team = null; eq.since = null;
      eq.receivedAt = null; eq.shipDate = null; eq.shipStage = null; eq.shipCanceled = false; eq.canceledAt = null;
      eq.prePackaging = false; eq.mfgInspected = false; eq.fqcInspected = false; eq.shipment = null;
      io.emit('update', eq);
      saveData();
      addLog('stage', u.id, u.name, `${eq.line}라인 ${eq.number}번 비우기 (${prevName})`, { equipmentId: eq.id, equipName: prevName, line: eq.line, slotNumber: eq.number });
      io.emit('newLog');
      if (ack) ack({ ok: true });
    } catch (e) { if (ack) ack({ error: '서버 오류' }); }
  });

  // 미배정 장비 슬롯 배정
  socket.on('assignPending', (data, ack) => {
    try {
      const { pendingId, targetId, password } = data || {};
      const u = socket.user;
      if (!u) { if (ack) ack({ error: '인증 필요' }); return; }
      const users = loadUsers();
      const user = users[u.id];
      if (!user || user.pw !== password) { if (ack) ack({ error: '비밀번호가 틀렸습니다' }); return; }
      if (user.dept !== '산업품질2팀' && u.id !== 'pjyc17') { if (ack) ack({ error: '권한이 없습니다' }); return; }
      const idx = pendingSlots.findIndex(p => p.id === pendingId);
      if (idx === -1) { if (ack) ack({ error: '미배정 항목을 찾을 수 없습니다' }); return; }
      const eq = equipment[targetId];
      if (!eq) { if (ack) ack({ error: '슬롯을 찾을 수 없습니다' }); return; }
      if (eq.status !== 'empty') { if (ack) ack({ error: '대상 슬롯이 비어있지 않습니다' }); return; }
      const p = pendingSlots[idx];
      eq.status = 'free'; eq.equipName = p.snName || p.trackingNo;
      eq.lotNo = p.trackingNo; eq.vendor = p.modelName;
      eq.model = p.fqcPerson; eq.prePackaging = p.prePackaging;
      eq.shipDate = p.shipDate; eq.shipStage = 'mail'; eq.receivedAt = Date.now();
      pendingSlots.splice(idx, 1);
      io.emit('update', eq); io.emit('pendingUpdate', pendingSlots);
      saveData();
      addLog('stage', u.id, u.name, `${eq.line}라인 ${eq.number}번 미배정 장비 배정 (${eq.equipName})`, { equipmentId: eq.id, equipName: eq.equipName, line: eq.line, slotNumber: eq.number, shipDate: eq.shipDate });
      io.emit('newLog');
      if (ack) ack({ ok: true });
    } catch (e) { if (ack) ack({ error: '서버 오류' }); }
  });

  // 수동 출하 등록
  socket.on('manualShip', (data, ack) => {
    try {
      const { targetId, equipName, trackingNo, vendor, fqcPerson, password } = data || {};
      const u = socket.user;
      if (!u) { if (ack) ack({ error: '인증 필요' }); return; }
      const users = loadUsers();
      const user = users[u.id];
      if (!user || user.pw !== password) { if (ack) ack({ error: '비밀번호가 틀렸습니다' }); return; }
      if (user.dept !== '산업품질2팀' && u.id !== 'pjyc17') { if (ack) ack({ error: '권한이 없습니다' }); return; }
      const eq = equipment[targetId];
      if (!eq) { if (ack) ack({ error: '슬롯을 찾을 수 없습니다' }); return; }
      if (eq.status !== 'empty') { if (ack) ack({ error: '대상 슬롯이 비어있지 않습니다' }); return; }
      eq.status = 'free'; eq.equipName = equipName || '';
      eq.lotNo = trackingNo || ''; eq.vendor = vendor || '';
      if (fqcPerson) eq.model = fqcPerson;
      eq.shipDate = Date.now(); eq.shipStage = 'mail'; eq.receivedAt = Date.now();
      io.emit('update', eq);
      saveData();
      addLog('schedule', u.id, u.name, `${eq.line}라인 ${eq.number}번 수동 출하 등록 (${eq.equipName})`, { equipmentId: eq.id, equipName: eq.equipName, line: eq.line, slotNumber: eq.number, shipDate: eq.shipDate });
      io.emit('newLog');
      if (ack) ack({ ok: true });
    } catch (e) { if (ack) ack({ error: '서버 오류' }); }
  });

  socket.on('cameraAction', ({ camId, action }) => {
    const u = socket.user;
    if (!u) return;
    const dept = u.dept || '';
    const isSuper = u.id === 'pjyc17';
    const isFQC = dept === '산업품질2팀';
    const isNT = dept === '엔티';
    if (!isFQC && !isNT && !isSuper) return;

    const cam = cameras[camId];
    if (!cam) return;

    switch (action) {
      case 'take':
        if (cam.status !== 'green' || (!isFQC && !isSuper)) return;
        cam.status = 'empty'; cam.takenBy = u.name; cam.takenAt = Date.now();
        break;
      case 'return_red':
        if (cam.status !== 'empty' || (!isFQC && !isSuper)) return;
        cam.status = 'red'; cam.takenBy = null; cam.takenAt = null;
        break;
      case 'return_urgent':
        if (cam.status !== 'empty' || (!isFQC && !isSuper)) return;
        cam.status = 'urgent'; cam.takenBy = null; cam.takenAt = null;
        break;
      case 'complete':
        if ((cam.status !== 'red' && cam.status !== 'urgent') || (!isFQC && !isNT && !isSuper)) return;
        cam.status = 'green'; cam.takenBy = null; cam.takenAt = null;
        break;
      default: return;
    }
    io.emit('cameraUpdate', cameras);
    saveCameras();
    const camNum = camId.replace('cam', '');
    addLog('camera', u.id, u.name, `카메라${camNum} ${action}`, { camId });
    io.emit('newLog');
  });
});

app.get('/rhksflwk', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>관리자</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, 'Malgun Gothic', sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; }
  h1 { font-size: 20px; margin-bottom: 16px; }
  h2 { font-size: 16px; margin: 24px 0 12px; color: #94a3b8; }
  .count { color: #3b82f6; font-size: 14px; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; margin-bottom: 24px; }
  th { text-align: left; padding: 10px 12px; background: #1e293b; border-bottom: 2px solid #334155; color: #94a3b8; }
  td { padding: 10px 12px; border-bottom: 1px solid #1e293b; }
  .device { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
  .device.phone { background: #065f46; color: #6ee7b7; }
  .device.pc { background: #1e3a5f; color: #7dd3fc; }
  .tabs { display: flex; gap: 8px; margin-bottom: 20px; }
  .tab { padding: 8px 16px; background: #1e293b; color: #94a3b8; border: 1px solid #334155; border-radius: 6px; cursor: pointer; font-size: 14px; }
  .tab.active { background: #3b82f6; color: #fff; border-color: #3b82f6; }
  .section { display: none; }
  .section.active { display: block; }
  .btn { padding: 8px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .btn-blue { background: #3b82f6; color: #fff; }
  .btn-blue:hover { background: #2563eb; }
  .btn-red { background: #dc2626; color: #fff; font-size: 12px; padding: 4px 10px; }
  .btn-red:hover { background: #b91c1c; }
  .btn-gray { background: #334155; color: #e2e8f0; }
  .btn-gray:hover { background: #475569; }
  .form-row { display: flex; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .form-input { padding: 8px 12px; background: #0f172a; border: 1px solid #334155; border-radius: 6px; color: #e2e8f0; font-size: 14px; }
  .form-input::placeholder { color: #475569; }
  .msg { padding: 8px 12px; border-radius: 6px; font-size: 13px; margin-top: 8px; }
  .msg.ok { background: #065f46; color: #6ee7b7; }
  .msg.err { background: #7f1d1d; color: #fca5a5; }
  .login-box { max-width: 320px; margin: 80px auto; }
  .login-box h1 { text-align: center; margin-bottom: 24px; }
  .login-box .form-input { width: 100%; margin-bottom: 10px; }
  .login-box .btn { width: 100%; }
</style>
</head>
<body>
  <div id="loginSection" class="login-box" style="display:none;">
    <h1>관리자 로그인</h1>
    <input class="form-input" id="loginId" placeholder="ID" autocomplete="off">
    <input class="form-input" id="loginPw" type="password" placeholder="비밀번호">
    <button class="btn btn-blue" onclick="doLogin()">로그인</button>
    <div id="loginMsg"></div>
  </div>

  <div id="adminSection" style="display:none;">
    <h1>관리자 페이지</h1>
    <div class="tabs">
      <div class="tab active" onclick="switchTab('clients')">접속자 현황</div>
      <div class="tab" onclick="switchTab('accounts')">계정 관리</div>
      <div class="tab" onclick="switchTab('logs')">활동 로그</div>
    </div>

    <div id="clients" class="section active">
      <button class="btn btn-gray" onclick="loadClients()">새로고침</button>
      <div class="count" id="count"></div>
      <table><thead><tr><th>#</th><th>이름</th><th>소속</th><th>IP</th><th>기기</th><th>브라우저</th><th>접속 시간</th></tr></thead>
      <tbody id="clientBody"></tbody></table>
    </div>

    <div id="accounts" class="section">
      <h2>계정 추가</h2>
      <div class="form-row">
        <input class="form-input" id="newId" placeholder="ID">
        <input class="form-input" id="newPw" placeholder="비밀번호">
        <input class="form-input" id="newName" placeholder="이름">
        <input class="form-input" id="newDept" placeholder="소속">
        <button class="btn btn-blue" onclick="addUser()">추가</button>
      </div>
      <div id="addMsg"></div>
      <h2>계정 목록</h2>
      <table><thead><tr><th>ID</th><th>이름</th><th>소속</th><th>권한</th><th></th></tr></thead>
      <tbody id="userBody"></tbody></table>
    </div>

    <div id="logs" class="section">
      <button class="btn btn-gray" onclick="loadLogs()">새로고침</button>
      <table style="margin-top:12px;"><thead><tr><th>시간</th><th>사용자</th><th>구분</th><th>내용</th></tr></thead>
      <tbody id="logBody"></tbody></table>
    </div>
  </div>

  <script>
    let token = localStorage.getItem('admin_token');

    async function doLogin() {
      const id = document.getElementById('loginId').value.trim();
      const pw = document.getElementById('loginPw').value;
      const res = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id,pw}) });
      const data = await res.json();
      if (!res.ok) { document.getElementById('loginMsg').innerHTML='<div class="msg err">'+data.error+'</div>'; return; }
      if (data.user.role !== 'admin') { document.getElementById('loginMsg').innerHTML='<div class="msg err">관리자 권한이 없습니다</div>'; return; }
      token = data.token;
      localStorage.setItem('admin_token', token);
      showAdmin();
    }

    async function checkAuth() {
      if (!token) { showLogin(); return; }
      const res = await fetch('/api/me', { headers: { 'Authorization': 'Bearer '+token } });
      if (!res.ok) { showLogin(); return; }
      const user = await res.json();
      if (user.role !== 'admin') { showLogin(); return; }
      showAdmin();
    }

    function showLogin() { document.getElementById('loginSection').style.display='block'; document.getElementById('adminSection').style.display='none'; }
    function showAdmin() { document.getElementById('loginSection').style.display='none'; document.getElementById('adminSection').style.display='block'; loadClients(); loadUsers(); loadLogs(); }

    function switchTab(name) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      event.target.classList.add('active');
      document.getElementById(name).classList.add('active');
    }

    async function loadClients() {
      const res = await fetch('/api/clients', { headers: { 'Authorization': 'Bearer '+token } });
      const data = await res.json();
      document.getElementById('count').textContent = '현재 '+data.length+'명 접속 중';
      const tbody = document.getElementById('clientBody');
      tbody.innerHTML = '';
      data.forEach((c,i) => {
        const tr = document.createElement('tr');
        const isPhone = /iPhone|Android|Mobile/i.test(c.userAgent);
        const device = isPhone ? '<span class="device phone">휴대폰</span>' : '<span class="device pc">PC</span>';
        let browser = 'Unknown';
        if (/Edg\\//i.test(c.userAgent)) browser = 'Edge';
        else if (/Chrome/i.test(c.userAgent)) browser = 'Chrome';
        else if (/Safari/i.test(c.userAgent)) browser = 'Safari';
        else if (/Firefox/i.test(c.userAgent)) browser = 'Firefox';
        const time = new Date(c.connectedAt).toLocaleString('ko-KR');
        tr.innerHTML = '<td>'+(i+1)+'</td><td>'+(c.userName||'-')+'</td><td>'+(c.userDept||'-')+'</td><td>'+c.ip+'</td><td>'+device+'</td><td>'+browser+'</td><td>'+time+'</td>';
        tbody.appendChild(tr);
      });
    }

    async function loadUsers() {
      const res = await fetch('/api/users', { headers: { 'Authorization': 'Bearer '+token } });
      if (!res.ok) return;
      const data = await res.json();
      const tbody = document.getElementById('userBody');
      tbody.innerHTML = '';
      data.forEach(u => {
        const tr = document.createElement('tr');
        const delBtn = u.id === 'admin' ? '' : '<button class="btn btn-red" onclick="delUser(\\''+u.id+'\\')">삭제</button>';
        tr.innerHTML = '<td>'+u.id+'</td><td>'+u.name+'</td><td>'+(u.dept||'-')+'</td><td>'+(u.role==='admin'?'관리자':'사용자')+'</td><td>'+delBtn+'</td>';
        tbody.appendChild(tr);
      });
    }

    async function addUser() {
      const id = document.getElementById('newId').value.trim();
      const pw = document.getElementById('newPw').value;
      const name = document.getElementById('newName').value.trim();
      const dept = document.getElementById('newDept').value.trim();
      const res = await fetch('/api/users', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+token}, body:JSON.stringify({id,pw,name,dept}) });
      const data = await res.json();
      document.getElementById('addMsg').innerHTML = '<div class="msg '+(res.ok?'ok':'err')+'">'+(data.message||data.error)+'</div>';
      if (res.ok) { document.getElementById('newId').value=''; document.getElementById('newPw').value=''; document.getElementById('newName').value=''; document.getElementById('newDept').value=''; loadUsers(); }
    }

    const actionLabels = { login:'로그인', register:'회원가입', receive:'입고', release:'출고', checkin:'체크인', checkout:'체크아웃', shipdate:'출고예정', inspect:'검수', schedule:'출하일정' };
    async function loadLogs() {
      const res = await fetch('/api/logs', { headers: { 'Authorization': 'Bearer '+token } });
      if (!res.ok) return;
      const data = await res.json();
      const tbody = document.getElementById('logBody');
      tbody.innerHTML = '';
      data.forEach(l => {
        const tr = document.createElement('tr');
        const time = new Date(l.time).toLocaleString('ko-KR');
        const label = actionLabels[l.action] || l.action;
        tr.innerHTML = '<td>'+time+'</td><td>'+(l.userName||'-')+'</td><td>'+label+'</td><td>'+l.detail+'</td>';
        tbody.appendChild(tr);
      });
    }

    async function delUser(id) {
      if (!confirm(id+' 계정을 삭제하시겠습니까?')) return;
      const res = await fetch('/api/users/'+id, { method:'DELETE', headers:{'Authorization':'Bearer '+token} });
      loadUsers();
    }

    checkAuth();
  </script>
  <script src="/socket.io/socket.io.js"></script>
  <script>
    let adminSocket = null;
    function connectAdminSocket() {
      if (adminSocket) adminSocket.disconnect();
      const t = localStorage.getItem('admin_token');
      if (!t) return;
      adminSocket = io({ auth: { token: t }, reconnection: false });
      adminSocket.on('clientCount', () => loadClients());
      adminSocket.on('newLog', () => loadLogs());
      adminSocket.on('disconnect', () => { adminSocket = null; });
    }
    const origShowAdmin = showAdmin;
    showAdmin = function() { origShowAdmin(); connectAdminSocket(); };
    if (localStorage.getItem('admin_token')) connectAdminSocket();
  </script>
</body>
</html>`);
});


function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

const PORT = 3000;
const SSL_PORT = 3443;

// HTTP → HTTPS 리다이렉트 전용 (API 처리 없음)
server.listen(PORT, '0.0.0.0');

httpsServer.listen(SSL_PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('');
  console.log('='.repeat(50));
  console.log('  설비 점유 현황 모니터링 서버 시작 (HTTPS)');
  console.log('='.repeat(50));
  console.log('');
  console.log(`  데이터 파일: ${DATA_FILE}`);
  console.log('');
  console.log(`  PC에서 접속:     https://localhost:${SSL_PORT}`);
  console.log(`  핸드폰에서 접속: https://${ip}:${SSL_PORT}`);
  console.log('');
  console.log('  * 처음 접속 시 "안전하지 않음" 경고 → "계속 진행" 클릭');
  console.log('  * 핸드폰과 이 PC가 같은 WiFi에 연결되어 있어야 합니다');
  console.log('='.repeat(50));
  console.log('');
});
