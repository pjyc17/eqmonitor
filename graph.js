const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'graph-config.json');
const TOKEN_FILE = path.join(__dirname, 'graph-tokens.json');
const STATE_FILE = path.join(__dirname, 'graph-state.json');

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE))
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (e) {}
  return { clientId: '', tenantId: '', clientSecret: '' };
}

function saveConfig(config) {
  atomicWrite(CONFIG_FILE, config);
}

function isConfigured() {
  const c = loadConfig();
  return !!(c.clientId && c.tenantId && c.clientSecret);
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKEN_FILE))
      return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
  } catch (e) {}
  return null;
}

function saveTokens(tokens) {
  atomicWrite(TOKEN_FILE, tokens);
}

function clearTokens() {
  if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE))
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {}
  return { lastChecked: null, lastEmailId: null };
}

function saveState(state) {
  atomicWrite(STATE_FILE, state);
}

const pendingStates = new Map();

function getAuthUrl(redirectUri) {
  const config = loadConfig();
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.set(state, Date.now());
  // 오래된 state 정리
  for (const [k, v] of pendingStates) {
    if (Date.now() - v > 600000) pendingStates.delete(k);
  }
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'Mail.Read Mail.ReadBasic Mail.Send offline_access openid',
    state,
    response_mode: 'query',
  });
  return {
    url: `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/authorize?${params}`,
    state,
  };
}

function validateState(state) {
  if (pendingStates.has(state)) {
    pendingStates.delete(state);
    return true;
  }
  return false;
}

async function exchangeCode(code, redirectUri) {
  const config = loadConfig();
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    scope: 'Mail.Read Mail.ReadBasic Mail.Send offline_access openid',
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }
  );

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error_description || err.error || '토큰 교환 실패');
  }

  const data = await res.json();
  const tokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  saveTokens(tokens);
  return tokens;
}

async function refreshAccessToken() {
  const config = loadConfig();
  const tokens = loadTokens();
  if (!tokens?.refreshToken) return null;

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: tokens.refreshToken,
    grant_type: 'refresh_token',
    scope: 'Mail.Read Mail.ReadBasic Mail.Send offline_access openid',
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }
  );

  if (!res.ok) {
    clearTokens();
    return null;
  }

  const data = await res.json();
  const newTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tokens.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  saveTokens(newTokens);
  return newTokens;
}

async function getAccessToken() {
  let tokens = loadTokens();
  if (!tokens) return null;
  if (Date.now() >= tokens.expiresAt - 60000) {
    tokens = await refreshAccessToken();
  }
  return tokens?.accessToken || null;
}

async function getStatus() {
  if (!isConfigured()) return { connected: false, reason: '설정 필요' };
  const tokens = loadTokens();
  if (!tokens) return { connected: false, reason: 'Microsoft 로그인 필요' };
  const accessToken = await getAccessToken();
  if (!accessToken) return { connected: false, reason: '토큰 만료 — 재로그인 필요' };
  const state = loadState();
  return { connected: true, lastChecked: state.lastChecked };
}

async function fetchShippingEmails(keyword) {
  const accessToken = await getAccessToken();
  if (!accessToken) throw new Error('인증이 필요합니다');

  const searchWord = keyword || '출하일정 송부';
  const select = 'id,subject,from,receivedDateTime,body';
  const url = `https://graph.microsoft.com/v1.0/me/messages?$search="${encodeURIComponent(searchWord)}"&$select=${select}&$top=10`;
  console.log(`  [Graph] fetch: ${url.substring(0, 120)}...`);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ConsistencyLevel: 'eventual',
    },
  });

  console.log(`  [Graph] status: ${res.status}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.log(`  [Graph] error:`, JSON.stringify(err).substring(0, 200));
    if (res.status === 401) { clearTokens(); throw new Error('인증 만료 — 재로그인 필요'); }
    throw new Error(err.error?.message || `Graph API 오류 (${res.status})`);
  }

  const data = await res.json();
  const emails = data.value || [];
  console.log(`  [Graph] raw results: ${emails.length}건`);
  // 최근 14일 내 메일만 필터
  const since = Date.now() - 14 * 24 * 60 * 60 * 1000;
  return emails
    .filter(e => new Date(e.receivedDateTime).getTime() > since)
    .sort((a, b) => new Date(b.receivedDateTime) - new Date(a.receivedDateTime));
}

function parseHtmlTableToText(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi);
  if (!tables) return '';

  let targetTable = null;
  for (const t of tables) {
    const text = t.replace(/<[^>]+>/g, '');
    if (/Tracking/i.test(text) && /FQC/i.test(text)) { targetTable = t; break; }
  }
  if (!targetTable) {
    targetTable = tables[0];
    for (const t of tables) { if (t.length > targetTable.length) targetTable = t; }
  }

  const rows = targetTable.match(/<tr[\s\S]*?<\/tr>/gi);
  if (!rows) return '';

  const lines = [];
  for (const row of rows) {
    const cells = row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi);
    if (!cells) continue;
    const values = cells.map(cell =>
      cell
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
        .trim()
    );
    lines.push(values.join('\t'));
  }
  return lines.join('\n');
}

function parseShipmentTable(html) {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi);
  if (!tables) return null;

  let targetTable = null;
  for (const t of tables) {
    const text = t.replace(/<[^>]+>/g, '');
    if (/shipment/i.test(text) && /tracking/i.test(text)) { targetTable = t; break; }
  }
  if (!targetTable) return null;

  const rows = targetTable.match(/<tr[\s\S]*?<\/tr>/gi);
  if (!rows || rows.length < 2) return null;

  const parseRow = (row) => {
    const cells = row.match(/<t[dh][\s\S]*?<\/t[dh]>/gi);
    if (!cells) return [];
    return cells.map(cell =>
      cell.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
        .trim()
    );
  };

  let headerIdx = -1;
  let headers = [];
  for (let i = 0; i < rows.length; i++) {
    const cells = parseRow(rows[i]);
    const joined = cells.join(' ').toLowerCase();
    if (joined.includes('shipment') && joined.includes('tracking')) {
      headers = cells.map(h => h.toLowerCase().replace(/[#＃]/g, '').trim());
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return null;

  const data = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const values = parseRow(rows[i]);
    if (!values.length || values.length < headers.length - 2) continue;
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = values[idx] || ''; });
    if (!obj['tracking'] && !obj['serial number']) continue;
    data.push(obj);
  }
  return { headers, data };
}

async function sendMail(to, subject, htmlBody, attachments) {
  const accessToken = await getAccessToken();
  if (!accessToken) throw new Error('인증이 필요합니다');

  const message = {
    message: {
      subject,
      body: { contentType: 'HTML', content: htmlBody },
      toRecipients: Array.isArray(to)
        ? to.map(addr => ({ emailAddress: { address: addr } }))
        : [{ emailAddress: { address: to } }],
    },
  };

  if (attachments && attachments.length > 0) {
    message.message.attachments = attachments.map(a => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: a.name,
      contentType: a.contentType,
      contentBytes: a.contentBytes,
    }));
  }

  const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(message),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (res.status === 401) { clearTokens(); throw new Error('인증 만료 — 재로그인 필요'); }
    throw new Error(err.error?.message || `메일 발송 실패 (${res.status})`);
  }
}

module.exports = {
  loadConfig, saveConfig, isConfigured,
  loadTokens, clearTokens,
  loadState, saveState,
  getAuthUrl, validateState, exchangeCode,
  getAccessToken, getStatus,
  fetchShippingEmails, parseHtmlTableToText, parseShipmentTable,
  sendMail,
};
