const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const HOST = process.env.CODEX_WEB_HOST || '127.0.0.1';
const PORT = Number(process.env.CODEX_WEB_PORT || 8081);
const HTTPS_PORT = Number(process.env.CODEX_WEB_HTTPS_PORT || 8443);
const HTTPS_KEY_FILE = process.env.CODEX_WEB_HTTPS_KEY || '/etc/codex-web/tls/server.key';
const HTTPS_CERT_FILE = process.env.CODEX_WEB_HTTPS_CERT || '/etc/codex-web/tls/server.crt';
const HTTPS_CA_FILE = process.env.CODEX_WEB_HTTPS_CA || '/etc/codex-web/tls/ca.crt';
const HTTPS_CA_DER_FILE = process.env.CODEX_WEB_HTTPS_CA_DER || '/etc/codex-web/tls/ca.cer';
const BASE_PATH = (process.env.CODEX_WEB_PATH || '/codex').replace(/\/$/, '');
const DATA_DIR = process.env.CODEX_WEB_DATA || '/var/lib/codex-web';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const STORE_FILE = path.join(DATA_DIR, 'conversations.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const REGISTRATION_KEY_FILE = path.join(DATA_DIR, 'registration.key');
const REGISTRATION_KEYS_FILE = path.join(DATA_DIR, 'registration-keys.json');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_TRANSIENT_TTL_MS = 12 * 60 * 60 * 1000;
const USERNAME_RE = /^[a-zA-Z0-9_-]{3,32}$/;
const MODELS_CACHE_FILE = '/root/.codex/models_cache.json';
const HTML = fs.readFileSync('/opt/codex-web/index.html', 'utf8');

const MAX_BODY_BYTES = 36 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 12000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_RUN_EVENTS = 300;
const MAX_RUN_OUTPUT_CHARS = 24000;
const MAX_RUN_STORAGE_BYTES = 512 * 1024;
const MAX_FILE_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const SNAPSHOT_SKIP_DIRS = new Set([
  '.codex', '.vscode-server', '.cache', '.npm', '.local', '.dotnet', '.copilot', '.ssh',
  '.git', 'node_modules', '__pycache__'
]);
const ALLOWED_IMAGES = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif']
]);
const ASSET_FILES = {
  openai: { path: '/root/openai.svg', type: 'image/svg+xml' },
  user: { path: '/root/1f914.png', type: 'image/png' },
  pwa: { path: '/opt/codex-web/pwa-icon.svg', type: 'image/svg+xml' }
};

fs.mkdirSync(UPLOAD_DIR, { recursive: true, mode: 0o700 });

function configValue(name, fallback) {
  try {
    const config = fs.readFileSync('/root/.codex/config.toml', 'utf8');
    const match = config.match(new RegExp(`^${name}\\s*=\\s*[\"']([^\"']+)[\"']`, 'm'));
    return match ? match[1] : fallback;
  } catch {
    return fallback;
  }
}

function loadModelCatalog() {
  const fallback = [
    { slug: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', description: '前沿编码模型', supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { slug: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra', description: '平衡速度与能力', supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { slug: 'gpt-5.6-luna', displayName: 'GPT-5.6-Luna', description: '高效、适合日常使用', supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { slug: 'gpt-5.5', displayName: 'GPT-5.5', description: '通用模型', supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'] },
    { slug: 'gpt-5.4', displayName: 'GPT-5.4', description: '通用模型', supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'] },
    { slug: 'gpt-5.4-mini', displayName: 'GPT-5.4-Mini', description: '更快、更省资源', supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'] }
  ];
  try {
    const cached = JSON.parse(fs.readFileSync(MODELS_CACHE_FILE, 'utf8'));
    const models = (cached.models || []).filter(model => model.visibility !== 'hidden' && model.slug && model.supported_api !== false && model.slug !== 'codex-auto-review');
    if (models.length) {
      return models.map(model => ({
        slug: model.slug,
        displayName: model.display_name || model.slug,
        description: model.description || '',
        supportedReasoningLevels: (model.supported_reasoning_levels || []).map(item => item.effort).filter(Boolean)
      }));
    }
  } catch {}
  return fallback;
}

const MODEL_CATALOG = loadModelCatalog();
const MODEL_MAP = new Map(MODEL_CATALOG.map(model => [model.slug, model]));
const DEFAULT_MODEL = MODEL_MAP.has(configValue('model', 'gpt-5.6-luna')) ? configValue('model', 'gpt-5.6-luna') : MODEL_CATALOG[0].slug;
const DEFAULT_REASONING = configValue('model_reasoning_effort', 'medium');

function normalizeSettings(model, reasoningEffort) {
  const selectedModel = MODEL_MAP.has(model) ? model : DEFAULT_MODEL;
  const modelInfo = MODEL_MAP.get(selectedModel);
  const levels = modelInfo.supportedReasoningLevels.length ? modelInfo.supportedReasoningLevels : ['low', 'medium', 'high', 'xhigh'];
  const selectedEffort = levels.includes(reasoningEffort)
    ? reasoningEffort
    : (levels.includes(DEFAULT_REASONING) ? DEFAULT_REASONING : (modelInfo.defaultReasoningLevel || levels[0]));
  return { model: selectedModel, reasoningEffort: selectedEffort };
}

function ensureSettings(conversation) {
  const settings = normalizeSettings(conversation.model, conversation.reasoningEffort);
  conversation.model = settings.model;
  conversation.reasoningEffort = settings.reasoningEffort;
  return settings;
}

function loadConversations() {
  try {
    const saved = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    if (Array.isArray(saved)) return saved;
  } catch {}
  return [];
}

let conversations = loadConversations();
// A conversation may have at most one active turn, but different
// conversations (and different users) can run at the same time.
const activeRuns = new Map();
let users = loadUsers();
const sessions = loadSessions();
const authAttempts = new Map();

function now() {
  return new Date().toISOString();
}

function persist() {
  const temporary = `${STORE_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(conversations, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, STORE_FILE);
}

function loadUsers() {
  try {
    const saved = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    if (Array.isArray(saved)) return saved;
  } catch {}
  return [];
}

function persistUsers() {
  const temporary = `${USERS_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, USERS_FILE);
}

function loadSessions() {
  const savedSessions = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    if (!Array.isArray(saved)) return savedSessions;
    for (const session of saved) {
      if (!session?.tokenHash || !session.userId || !Number.isFinite(session.expiresAt)) continue;
      if (session.expiresAt <= Date.now()) continue;
      savedSessions.set(session.tokenHash, { userId: session.userId, expiresAt: session.expiresAt, persistent: true });
    }
  } catch {}
  return savedSessions;
}

function persistSessions() {
  const saved = [];
  for (const [tokenHash, session] of sessions) {
    if (!session?.persistent || session.expiresAt <= Date.now()) continue;
    saved.push({ tokenHash, userId: session.userId, expiresAt: session.expiresAt });
  }
  const temporary = `${SESSIONS_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(saved, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, SESSIONS_FILE);
  try { fs.chmodSync(SESSIONS_FILE, 0o600); } catch {}
}

function persistRegistrationKeys() {
  const temporary = `${REGISTRATION_KEYS_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify([...registrationKeys], null, 2), { mode: 0o600 });
  fs.renameSync(temporary, REGISTRATION_KEYS_FILE);
  try { fs.chmodSync(REGISTRATION_KEYS_FILE, 0o600); } catch {}
}

function loadRegistrationKeys() {
  const keys = new Set();
  try {
    const saved = JSON.parse(fs.readFileSync(REGISTRATION_KEYS_FILE, 'utf8'));
    if (Array.isArray(saved)) saved.filter(item => typeof item === 'string' && item.trim()).forEach(item => keys.add(item.trim()));
  } catch {}
  // Keep the first key generated by the original single-key implementation usable.
  try {
    const legacy = fs.readFileSync(REGISTRATION_KEY_FILE, 'utf8').trim();
    if (legacy) keys.add(legacy);
  } catch {}
  const configured = String(process.env.CODEX_WEB_REGISTRATION_KEY || '').trim();
  if (configured) keys.add(configured);
  if (!keys.size) keys.add(crypto.randomBytes(24).toString('base64url'));
  return keys;
}

let registrationKeys = loadRegistrationKeys();
persistRegistrationKeys();

function createRegistrationKey() {
  let key = '';
  do { key = crypto.randomBytes(24).toString('base64url'); } while (registrationKeys.has(key));
  registrationKeys.add(key);
  persistRegistrationKeys();
  return key;
}

function consumeRegistrationKey(value) {
  for (const key of registrationKeys) {
    if (!valuesEqual(key, value)) continue;
    registrationKeys.delete(key);
    persistRegistrationKeys();
    return true;
  }
  return false;
}

function registrationKeyExists(value) {
  for (const key of registrationKeys) if (valuesEqual(key, value)) return true;
  return false;
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null
  };
}

function findUserByUsername(username) {
  return users.find(user => user.username.toLowerCase() === String(username || '').toLowerCase());
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
}

function passwordMatches(user, password) {
  if (!user?.passwordSalt || !user?.passwordHash) return false;
  const actual = Buffer.from(hashPassword(password, user.passwordSalt), 'hex');
  const expected = Buffer.from(user.passwordHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function valuesEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function sessionHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSession(user, rememberMe = false) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(sessionHash(token), {
    userId: user.id,
    expiresAt: Date.now() + (rememberMe ? SESSION_TTL_MS : SESSION_TRANSIENT_TTL_MS),
    persistent: Boolean(rememberMe)
  });
  if (rememberMe) persistSessions();
  return token;
}

function currentUser(req) {
  const token = parseCookies(req).codex_session;
  if (!token) return null;
  const session = sessions.get(sessionHash(token));
  if (!session || session.expiresAt <= Date.now()) {
    if (session) {
      sessions.delete(sessionHash(token));
      if (session.persistent) persistSessions();
    }
    return null;
  }
  const user = users.find(item => item.id === session.userId);
  if (!user || user.disabled) return null;
  return user;
}

function setSessionCookie(res, token, rememberMe = false) {
  const maxAge = rememberMe ? `; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}` : '';
  res.setHeader('Set-Cookie', `codex_session=${encodeURIComponent(token)}; Path=${BASE_PATH}/${maxAge}; HttpOnly; Secure; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `codex_session=; Path=${BASE_PATH}/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}

function authRateKey(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function authRateLimited(req) {
  const key = authRateKey(req);
  const entry = authAttempts.get(key);
  if (!entry || entry.resetAt <= Date.now()) {
    authAttempts.set(key, { failures: 0, resetAt: Date.now() + 10 * 60 * 1000 });
    return false;
  }
  return entry.failures >= 10;
}

function recordAuthFailure(req) {
  const key = authRateKey(req);
  const entry = authAttempts.get(key) || { failures: 0, resetAt: Date.now() + 10 * 60 * 1000 };
  entry.failures += 1;
  authAttempts.set(key, entry);
}

function clearAuthFailures(req) {
  authAttempts.delete(authRateKey(req));
}

function ensureBootstrapRootUser() {
  let root = users.find(user => user.username.toLowerCase() === 'root');
  const bootstrapPassword = process.env.CODEX_WEB_BOOTSTRAP_ROOT_PASSWORD || '';
  if (!root && bootstrapPassword) {
    const salt = crypto.randomBytes(16).toString('hex');
    root = {
      id: crypto.randomUUID(),
      username: 'root',
      role: 'admin',
      disabled: false,
      passwordSalt: salt,
      passwordHash: hashPassword(bootstrapPassword, salt),
      createdAt: now(),
      lastLoginAt: null
    };
    users.unshift(root);
    persistUsers();
  }
  if (!root) return;
  let migrated = false;
  for (const conversation of conversations) {
    if (!conversation.ownerId) {
      conversation.ownerId = root.id;
      migrated = true;
    }
  }
  if (migrated) persist();
}

function titleFromMessage(message) {
  const title = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return title || '新对话';
}

function updateInitialConversationTitle(conversation, message) {
  if (!conversation || conversation.title !== '新对话') return false;
  const title = titleFromMessage(message);
  if (title === '新对话') return false;
  conversation.title = title;
  return true;
}

function migrateConversationTitles() {
  let changed = false;
  for (const conversation of conversations) {
    if (conversation.title !== '新对话') continue;
    const firstUserMessage = conversation.messages?.find(item => item.role === 'user' && item.text);
    if (firstUserMessage && updateInitialConversationTitle(conversation, firstUserMessage.text)) changed = true;
  }
  if (changed) persist();
}

ensureBootstrapRootUser();
migrateConversationTitles();

function send(res, status, type, body, extraHeaders = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    ...extraHeaders
  });
  res.end(payload);
}

function json(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY_BYTES) {
      reject(new Error('请求太大，请减少图片数量或压缩图片后重试。'));
      req.resume();
      return;
    }
    let data = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求太大，请减少图片数量或压缩图片后重试。'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function createConversation(title = '新对话', requestedSettings = {}, ownerId = null) {
  const stamp = now();
  const settings = normalizeSettings(requestedSettings.model, requestedSettings.reasoningEffort);
  const conversation = {
    id: crypto.randomUUID(),
    title,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    ownerId,
    createdAt: stamp,
    updatedAt: stamp,
    messages: []
  };
  conversations.unshift(conversation);
  persist();
  return conversation;
}

function canAccessConversation(conversation, user) {
  if (!conversation || !user) return false;
  // Conversations are private to their owner, including for administrators.
  return conversation.ownerId === user.id;
}

function findConversation(id, user) {
  const conversation = conversations.find(item => item.id === id);
  return canAccessConversation(conversation, user) ? conversation : null;
}

function publicImage(image) {
  return {
    id: image.id,
    name: image.name,
    type: image.type,
    size: image.size,
    url: `${BASE_PATH}/api/images/${encodeURIComponent(image.id)}`
  };
}

function truncateRunText(value, limit = MAX_RUN_OUTPUT_CHARS) {
  const text = String(value ?? '');
  return text.length > limit ? `${text.slice(0, limit)}\n…（历史记录已截断）` : text;
}

function compactRunEvent(event) {
  if (!event || !['status', 'thought', 'tool_started', 'tool_completed', 'tool', 'process', 'file_change', 'diagnostic', 'error', 'context_compacted'].includes(event.type)) return null;
  const saved = { type: event.type };
  for (const key of ['tool', 'phase', 'itemId', 'command', 'status', 'exitCode', 'text']) {
    if (event[key] !== undefined && event[key] !== null && event[key] !== '') saved[key] = event[key];
  }
  if (event.output) saved.output = truncateRunText(event.output);
  if (event.data !== undefined && event.data !== null) {
    let serialized = '';
    try { serialized = JSON.stringify(event.data, null, 2); } catch { serialized = String(event.data); }
    saved.data = serialized.length > MAX_RUN_OUTPUT_CHARS ? truncateRunText(serialized) : event.data;
  }
  return saved;
}

function publicMessage(message) {
  const result = {
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    error: Boolean(message.error),
    images: (message.images || []).map(publicImage)
  };
  if (Array.isArray(message.runEvents) && message.runEvents.length) result.runEvents = message.runEvents;
  return result;
}

function saveErrorMessage(conversation, text, runEvents = []) {
  if (!conversation) return null;
  const message = {
    id: crypto.randomUUID(),
    role: 'assistant',
    text,
    images: [],
    error: true,
    createdAt: now(),
    runEvents: runEvents.slice(0, MAX_RUN_EVENTS)
  };
  conversation.messages.push(message);
  conversation.updatedAt = now();
  sortConversations();
  persist();
  return message;
}

function publicConversation(conversation) {
  const settings = ensureSettings(conversation);
  return {
    id: conversation.id,
    title: conversation.title,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    running: activeRuns.has(conversation.id),
    messages: conversation.messages.map(publicMessage)
  };
}

function conversationSummary(conversation) {
  const last = conversation.messages[conversation.messages.length - 1];
  const settings = ensureSettings(conversation);
  return {
    id: conversation.id,
    title: conversation.title,
    model: settings.model,
    reasoningEffort: settings.reasoningEffort,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    preview: last ? last.text.slice(0, 90) : '还没有消息',
    running: activeRuns.has(conversation.id)
  };
}

function sortConversations() {
  conversations.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function imageById(id, user) {
  for (const conversation of conversations) {
    if (!canAccessConversation(conversation, user)) continue;
    for (const message of conversation.messages) {
      for (const image of message.images || []) {
        if (image.id === id) return image;
      }
    }
  }
  return null;
}

function parseImages(rawImages) {
  if (rawImages === undefined) return [];
  if (!Array.isArray(rawImages) || rawImages.length > 4) {
    throw new Error('一次最多上传 4 张图片。');
  }

  let total = 0;
  const created = [];
  try {
    const result = rawImages.map(raw => {
      const type = typeof raw?.type === 'string' ? raw.type.toLowerCase() : '';
      const extension = ALLOWED_IMAGES.get(type);
      if (!extension) throw new Error('目前只支持 PNG、JPEG 和 GIF 图片。');
      const dataUrl = typeof raw?.data === 'string' ? raw.data : '';
      const match = dataUrl.match(/^data:([^;]+);base64,([a-z0-9+/=]+)$/i);
      if (!match || match[1].toLowerCase() !== type) throw new Error('图片数据格式不正确。');
      const buffer = Buffer.from(match[2], 'base64');
      if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
        throw new Error('单张图片不能超过 20 MB。');
      }
      total += buffer.length;
      if (total > MAX_TOTAL_IMAGE_BYTES) throw new Error('一次上传的图片总大小不能超过 24 MB。');

      const id = `${crypto.randomUUID()}${extension}`;
      const filePath = path.join(UPLOAD_DIR, id);
      fs.writeFileSync(filePath, buffer, { mode: 0o600 });
      created.push(filePath);
      return {
        id,
        name: String(raw.name || `image${extension}`).slice(0, 160),
        type,
        size: buffer.length,
        path: filePath
      };
    });
    return result;
  } catch (error) {
    for (const filePath of created) {
      try { fs.unlinkSync(filePath); } catch {}
    }
    throw error;
  }
}

function buildPrompt(conversation, message, images, options = {}) {
  const readOnly = options.readOnly === true;
  const context = conversation.messages.slice(-14).map(item => {
    const role = item.role === 'user' ? '用户' : '助手';
    const attached = item.images?.length ? `\n[该消息包含图片：${item.images.map(image => image.name).join('、')}]` : '';
    return `${role}：${item.text}${attached}`;
  }).join('\n\n');
  const currentImages = images.length
    ? `\n[当前消息包含图片：${images.map(image => image.name).join('、')}]`
    : '';
  const environment = [
    '[运行环境说明]',
    '你运行在这台远程 VPS 上，用户通过手机 Web 控制你；手机只是客户端，不是命令和文件的执行端。',
    readOnly
      ? '当前登录用户是普通用户，本次会话为严格只读模式：只能查看文件、读取状态和执行不会改变系统或文件的诊断命令；禁止创建、编辑、删除、移动文件，安装软件，修改配置，重启或管理服务。若用户要求修改，说明需要管理员权限，不要尝试绕过限制。'
      : '当前登录用户是管理员，按用户授权可在 VPS 上查看、修改文件、执行命令和管理服务。',
    '服务器、Codex、手机 Web、代理/梯子说明见 /root/VPS服务器说明.md；遇到相关问题再读取，不要主动复述这段说明。',
    '“手机 Web”默认指当前控制界面；不要为了测试当前对话索要手机 IP/URL，除非用户明确说的是另一个 Web 服务。回答简洁，适合手机阅读。'
  ].join('\n');
  return [
    readOnly
      ? '你是运行在用户服务器上的 Codex 助手。请用简洁、清楚的中文回答；当前权限是只读，绝不要执行任何会修改文件、系统或服务的操作。'
      : '你是运行在用户服务器上的 Codex 助手。请用简洁、清楚的中文回答；只有用户明确要求时才修改文件或执行有副作用的操作。',
    environment,
    context ? `此前对话：\n${context}` : '',
    `用户当前问题：\n${message}${currentImages}`
  ].filter(Boolean).join('\n\n');
}

function runCodex(prompt, images, settings, options = {}) {
  return new Promise((resolve, reject) => {
    const output = path.join(os.tmpdir(), `codex-web-${process.pid}-${Date.now()}.txt`);
    const readOnly = options.readOnly === true;
    const runKey = options.runKey || crypto.randomUUID();
    const args = [
      'exec', '--ephemeral', '--json', '--color', 'never',
      ...(readOnly ? ['--sandbox', 'read-only'] : ['--dangerously-bypass-approvals-and-sandbox']),
      '--skip-git-repo-check', '-C', '/root', '-m', settings.model,
      '-c', `model_reasoning_effort=\"${settings.reasoningEffort}\"`
    ];
    for (const image of images) args.push('--image', image.path);
    args.push('-o', output, '-');

    const child = spawn('/usr/local/bin/codex', args, {
      cwd: '/root',
      env: { ...process.env, TERM: 'dumb' },
      stdio: ['pipe', 'ignore', 'pipe']
    });
    const run = {
      child,
      cancelled: false,
      stop() {
        if (this.cancelled) return;
        this.cancelled = true;
        terminateChild(this.child);
        setTimeout(() => terminateChild(this.child, 'SIGKILL'), 3000).unref();
      }
    };
    activeRuns.set(runKey, run);
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, 240000);
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
      if (stderr.length > 12000) stderr = stderr.slice(-12000);
    });
    child.on('error', error => {
      clearTimeout(timer);
      if (activeRuns.get(runKey) === run) activeRuns.delete(runKey);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (activeRuns.get(runKey) === run) activeRuns.delete(runKey);
      let answer = '';
      try { answer = fs.readFileSync(output, 'utf8').trim(); } catch {}
      try { fs.unlinkSync(output); } catch {}
      if (timedOut) return reject(new Error('Codex 响应超时，请稍后重试。'));
      if (code !== 0 || !answer) {
        return reject(new Error(answer || stderr.trim() || `Codex exited with code ${code}`));
      }
      resolve(answer);
    });
    child.stdin.end(prompt);
  });
}

function emitStreamEvent(res, event) {
  if (!res.writableEnded && !res.destroyed) {
    res.write(`${JSON.stringify(event)}\n`);
  }
}

function processItemEvent(phase, item) {
  const type = item?.type || 'process';
  if (/context[_ -]?compac|compaction/i.test(type)) {
    return { type: 'context_compacted', tool: '上下文', phase, itemId: item?.id || '', data: item };
  }
  if (type === 'agent_message') {
    return { type: 'thought', text: item.text || '' };
  }
  if (type === 'command_execution') {
    return {
      type: phase === 'started' ? 'tool_started' : 'tool_completed',
      tool: '终端',
      command: item.command || '',
      output: item.aggregated_output || '',
      status: item.status || (phase === 'started' ? 'in_progress' : 'completed'),
      exitCode: item.exit_code ?? null
    };
  }
  if (type === 'file_change' || type === 'file_change_output') {
    return { type: 'file_change', tool: '文件变更', itemId: item?.id || '', data: item };
  }
  if (type.includes('mcp') || type.includes('web_search') || type.includes('tool')) {
    return { type: 'tool', tool: type, phase, itemId: item?.id || '', data: item };
  }
  return { type: 'process', tool: type, phase, itemId: item?.id || '', data: item };
}

function fileChangeEntries(item) {
  if (Array.isArray(item?.changes) && item.changes.length) return item.changes;
  const filePath = item?.path || item?.file_path || item?.filename || '';
  return filePath ? [{ path: filePath, kind: item?.kind || 'update' }] : [];
}

function readFileState(filePath) {
  try { return { exists: true, text: fs.readFileSync(filePath, 'utf8') }; }
  catch { return { exists: false, text: '' }; }
}

function captureWorkspaceSnapshot(root = '/root') {
  const snapshots = new Map();
  const visit = directory => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (SNAPSHOT_SKIP_DIRS.has(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(filePath);
      } else if (entry.isFile()) {
        try {
          if (fs.statSync(filePath).size <= MAX_FILE_SNAPSHOT_BYTES) {
            snapshots.set(filePath, readFileState(filePath));
          }
        } catch {}
      }
    }
  };
  visit(root);
  return snapshots;
}

function isSnapshotCovered(filePath, root = '/root') {
  const relative = path.relative(root, filePath);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  return relative.split(path.sep).every(part => !SNAPSHOT_SKIP_DIRS.has(part));
}

function fileLines(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineDiffStats(before, after) {
  if (before.text === after.text) return { additions: 0, deletions: 0 };
  const oldLines = fileLines(before.text);
  const newLines = fileLines(after.text);
  if (!before.exists && after.exists) return { additions: newLines.length, deletions: 0 };
  if (before.exists && !after.exists) return { additions: 0, deletions: oldLines.length };
  const cells = oldLines.length * newLines.length;
  if (cells > 250000) {
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
    return {
      additions: newLines.length - prefix - suffix,
      deletions: oldLines.length - prefix - suffix
    };
  }
  let previous = new Uint32Array(newLines.length + 1);
  for (let i = 1; i <= oldLines.length; i += 1) {
    const current = new Uint32Array(newLines.length + 1);
    for (let j = 1; j <= newLines.length; j += 1) {
      current[j] = oldLines[i - 1] === newLines[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  const common = previous[newLines.length];
  return { additions: newLines.length - common, deletions: oldLines.length - common };
}

function snapshotFileChanges(item, workspaceSnapshot, latestFileStates) {
  const snapshots = {};
  for (const change of fileChangeEntries(item)) {
    const filePath = change?.path || change?.file_path || change?.filename || '';
    if (!filePath || snapshots[filePath]) continue;
    if (latestFileStates?.has(filePath)) snapshots[filePath] = latestFileStates.get(filePath);
    else if (workspaceSnapshot?.has(filePath)) snapshots[filePath] = workspaceSnapshot.get(filePath);
    else if (isSnapshotCovered(filePath)) snapshots[filePath] = { exists: false, text: '' };
    else snapshots[filePath] = readFileState(filePath);
  }
  return snapshots;
}

function enrichFileChangeEvent(event, item, snapshots) {
  const changes = fileChangeEntries(item).map(change => {
    const filePath = change?.path || change?.file_path || change?.filename || '';
    const before = snapshots?.[filePath] || { exists: false, text: '' };
    const after = filePath ? readFileState(filePath) : { exists: false, text: '' };
    const stats = lineDiffStats(before, after);
    const kind = String(change?.kind || item?.kind || '').toLowerCase();
    const normalized = { ...change };
    // A zero/zero result is not useful to display and can happen when the
    // Codex file-change event arrives after the write. Keep real counts only.
    if (stats.additions > 0 || stats.deletions > 0) {
      normalized.additions = stats.additions;
      normalized.deletions = stats.deletions;
    } else if (!before.exists && after.exists) {
      normalized.additions = fileLines(after.text).length;
      normalized.deletions = 0;
    } else {
      delete normalized.additions;
      delete normalized.deletions;
    }
    if (/^(add|create)$/.test(kind) && after.exists && !Number.isFinite(Number(normalized.additions))) {
      normalized.additions = fileLines(after.text).length;
      normalized.deletions = 0;
    }
    return normalized;
  });
  return { ...event, data: { ...item, changes } };
}

function terminateChild(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch {} }
}

function runCodexStream(prompt, images, settings, onEvent, options = {}) {
  return new Promise((resolve, reject) => {
    const output = path.join(os.tmpdir(), `codex-web-${process.pid}-${Date.now()}.txt`);
    const readOnly = options.readOnly === true;
    const runKey = options.runKey || crypto.randomUUID();
    const args = [
      'exec', '--ephemeral', '--json', '--color', 'never',
      ...(readOnly ? ['--sandbox', 'read-only'] : ['--dangerously-bypass-approvals-and-sandbox']),
      '--skip-git-repo-check', '-C', '/root', '-m', settings.model,
      '-c', `model_reasoning_effort=\"${settings.reasoningEffort}\"`
    ];
    for (const image of images) args.push('--image', image.path);
    args.push('-o', output, '-');

    // File-change events often arrive after Codex has already written the
    // file, so take the baseline before starting the child process.
    const workspaceSnapshot = captureWorkspaceSnapshot();
    const latestFileStates = new Map(workspaceSnapshot);
    const child = spawn('/usr/local/bin/codex', args, {
      cwd: '/root',
      env: { ...process.env, TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true
    });
    const run = {
      child,
      cancelled: false,
      stop() {
        if (this.cancelled) return;
        this.cancelled = true;
        onEvent({ type: 'status', text: '正在停止' });
        terminateChild(this.child);
        setTimeout(() => terminateChild(this.child, 'SIGKILL'), 3000).unref();
      }
    };
    activeRuns.set(runKey, run);
    let buffer = '';
    let stderr = '';
    // Codex emits the final answer once as an `agent_message` progress item
    // and then writes it to the output file. Hold the latest one back so the
    // live process panel does not briefly show the same answer twice.
    let pendingAgentMessage = null;
    const flushPendingAgentMessage = () => {
      if (!pendingAgentMessage) return;
      onEvent(pendingAgentMessage);
      pendingAgentMessage = null;
    };
    let timedOut = false;
    const fileSnapshots = new Map();
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChild(child);
    }, 240000);

    const handleLine = line => {
      if (!line.trim()) return;
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'thread.started') {
        onEvent({ type: 'thread', threadId: event.thread_id });
      } else if (event.type === 'item.started') {
        flushPendingAgentMessage();
        const itemEvent = processItemEvent('started', event.item);
        if (itemEvent.type === 'file_change') fileSnapshots.set(itemEvent.itemId || crypto.randomUUID(), snapshotFileChanges(event.item, workspaceSnapshot, latestFileStates));
        onEvent(itemEvent);
      } else if (event.type === 'item.completed') {
        let itemEvent = processItemEvent('completed', event.item);
        if (itemEvent.type === 'file_change') {
          const snapshotKey = itemEvent.itemId;
          const snapshots = fileSnapshots.get(snapshotKey);
          itemEvent = enrichFileChangeEvent(itemEvent, event.item, snapshots);
          for (const change of fileChangeEntries(event.item)) {
            const filePath = change?.path || change?.file_path || change?.filename || '';
            if (filePath) latestFileStates.set(filePath, readFileState(filePath));
          }
          fileSnapshots.delete(snapshotKey);
        }
        if (itemEvent.type === 'thought' && itemEvent.text) {
          flushPendingAgentMessage();
          pendingAgentMessage = itemEvent;
        } else {
          flushPendingAgentMessage();
          onEvent(itemEvent);
        }
      } else if (event.type === 'turn.started') {
        flushPendingAgentMessage();
        onEvent({ type: 'status', text: 'Codex 已开始处理' });
      } else if (event.type === 'turn.completed') {
        // The pending agent message is the final answer already present in
        // the output file. Do not emit it as a small progress line.
        pendingAgentMessage = null;
        onEvent({ type: 'status', text: 'Codex 处理完成', usage: event.usage || null });
      } else if (event.type === 'turn.failed') {
        flushPendingAgentMessage();
        onEvent({ type: 'error', text: event.error?.message || 'Codex 处理失败' });
      } else if (/context[_ -]?compac|compaction/i.test(event.type || '')) {
        flushPendingAgentMessage();
        onEvent({ type: 'context_compacted', tool: '上下文', data: event });
      } else {
        flushPendingAgentMessage();
        onEvent({ type: 'process', tool: event.type, data: event });
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      lines.forEach(handleLine);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });
    child.on('error', error => {
      clearTimeout(timer);
      if (activeRuns.get(runKey) === run) activeRuns.delete(runKey);
      try { fs.unlinkSync(output); } catch {}
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (activeRuns.get(runKey) === run) activeRuns.delete(runKey);
      if (buffer.trim()) handleLine(buffer);
      let answer = '';
      try { answer = fs.readFileSync(output, 'utf8').trim(); } catch {}
      try { fs.unlinkSync(output); } catch {}
      if (stderr.trim() && !/state db discrepancy|falling back/i.test(stderr)) {
        onEvent({ type: 'diagnostic', text: stderr.trim() });
      }
      if (timedOut) return reject(new Error('Codex 响应超时，请稍后重试。'));
      if (run.cancelled) return reject(new Error('当前任务已停止。'));
      if (code !== 0 || (!answer && !lastAgentMessage)) {
        return reject(new Error(answer || lastAgentMessage || stderr.trim() || `Codex exited with code ${code}`));
      }
      resolve({ answer: answer || lastAgentMessage });
    });
    child.stdin.end(prompt);
  });
}

function branchConversation(conversation, messageId, ownerId) {
  const endIndex = conversation.messages.findIndex(item => item.id === messageId);
  if (endIndex < 0) throw new Error('找不到要分支的消息。');
  const stamp = now();
  const branch = {
    id: crypto.randomUUID(),
    title: `${String(conversation.title || '对话').slice(0, 52)} · 分支`,
    model: conversation.model,
    reasoningEffort: conversation.reasoningEffort,
    ownerId,
    createdAt: stamp,
    updatedAt: stamp,
    messages: []
  };
  branch.messages = conversation.messages.slice(0, endIndex + 1).map(message => ({
    id: crypto.randomUUID(),
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    runEvents: Array.isArray(message.runEvents) ? message.runEvents : [],
    images: (message.images || []).map(image => {
      const extension = path.extname(image.path || '') || '.png';
      const id = `${crypto.randomUUID()}${extension}`;
      const target = path.join(UPLOAD_DIR, id);
      try { fs.copyFileSync(image.path, target); } catch { return null; }
      return { id, name: image.name, type: image.type, size: image.size, path: target };
    }).filter(Boolean)
  }));
  conversations.unshift(branch);
  persist();
  return branch;
}

function deleteStoredImages(conversation) {
  for (const message of conversation.messages) {
    for (const image of message.images || []) {
      if (image.path && image.path.startsWith(`${UPLOAD_DIR}${path.sep}`)) {
        try { fs.unlinkSync(image.path); } catch {}
      }
    }
  }
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname.replace(/\/$/, '') || '/';
  const api = `${BASE_PATH}/api`;

  if (pathname === BASE_PATH || pathname === `${BASE_PATH}/index.html`) {
    return send(res, 200, 'text/html; charset=utf-8', HTML.replaceAll('__CODEX_BASE__', BASE_PATH));
  }

  if (pathname === `${BASE_PATH}/manifest.json` && req.method === 'GET') {
    return json(res, 200, {
      id: `${BASE_PATH}/`,
      name: 'Codex',
      short_name: 'Codex',
      start_url: `${BASE_PATH}/`,
      scope: `${BASE_PATH}/`,
      display: 'standalone',
      display_override: ['standalone'],
      background_color: '#000000',
      theme_color: '#000000',
      lang: 'zh-CN',
      orientation: 'portrait',
      icons: [
        { src: `${BASE_PATH}/api/assets/pwa`, sizes: '192x192 512x512', type: 'image/svg+xml', purpose: 'any' }
      ]
    });
  }

  if (pathname === `${BASE_PATH}/sw.js` && req.method === 'GET') {
    const worker = [
      "self.addEventListener('install', () => self.skipWaiting());",
      "self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));",
      "self.addEventListener('fetch', event => {",
      "  if (event.request.method === 'GET' && event.request.mode === 'navigate') event.respondWith(fetch(event.request));",
      "});"
    ].join('\n');
    return send(res, 200, 'application/javascript; charset=utf-8', worker, {
      'Service-Worker-Allowed': `${BASE_PATH}/`
    });
  }

  const assetPath = `${api}/assets/`;
  if (pathname === `${api}/codex-ca.crt` && req.method === 'GET' && fs.existsSync(HTTPS_CA_FILE)) {
    return send(res, 200, 'application/x-x509-ca-cert', fs.readFileSync(HTTPS_CA_FILE), {
      'Content-Disposition': 'attachment; filename="codex-web-ca.crt"',
      'Cache-Control': 'private, max-age=86400'
    });
  }
  if (pathname === `${api}/codex-ca.cer` && req.method === 'GET' && fs.existsSync(HTTPS_CA_DER_FILE)) {
    return send(res, 200, 'application/pkix-cert', fs.readFileSync(HTTPS_CA_DER_FILE), {
      'Content-Disposition': 'attachment; filename="codex-web-ca.cer"',
      'Cache-Control': 'private, max-age=86400'
    });
  }

  if (pathname.startsWith(assetPath) && req.method === 'GET') {
    const asset = ASSET_FILES[pathname.slice(assetPath.length)];
    if (!asset || !fs.existsSync(asset.path)) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    return send(res, 200, asset.type, fs.readFileSync(asset.path), { 'Cache-Control': 'private, max-age=3600' });
  }

  if (pathname === `${api}/auth/status` && req.method === 'GET') {
    const user = currentUser(req);
    return json(res, 200, {
      authenticated: Boolean(user),
      user: user ? publicUser(user) : null,
      registrationAvailable: true,
      hasUsers: users.length > 0
    });
  }

  if (pathname === `${api}/auth/register` && req.method === 'POST') {
    if (authRateLimited(req)) return json(res, 429, { error: '尝试次数过多，请 10 分钟后再试。' });
    try {
      const body = JSON.parse(await readBody(req));
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const inviteKey = typeof body.inviteKey === 'string' ? body.inviteKey.trim() : '';
      const rememberMe = Boolean(body.rememberMe);
      if (!registrationKeyExists(inviteKey)) {
        recordAuthFailure(req);
        return json(res, 403, { error: '注册密钥不正确。' });
      }
      if (!USERNAME_RE.test(username)) return json(res, 400, { error: '用户名需为 3–32 位字母、数字、下划线或短横线。' });
      if (password.length < 8 || password.length > 200) return json(res, 400, { error: '密码长度需为 8–200 位。' });
      if (findUserByUsername(username)) return json(res, 409, { error: '用户名已存在。' });
      if (!consumeRegistrationKey(inviteKey)) {
        recordAuthFailure(req);
        return json(res, 403, { error: '注册密钥已被使用或不正确。' });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const user = {
        id: crypto.randomUUID(),
        username,
        role: users.length ? 'user' : 'admin',
        disabled: false,
        passwordSalt: salt,
        passwordHash: hashPassword(password, salt),
        createdAt: now(),
        lastLoginAt: now()
      };
      users.push(user);
      persistUsers();
      clearAuthFailures(req);
      setSessionCookie(res, createSession(user, rememberMe), rememberMe);
      return json(res, 201, { user: publicUser(user) });
    } catch (error) {
      return json(res, 400, { error: error.message || '注册失败。' });
    }
  }

  if (pathname === `${api}/auth/login` && req.method === 'POST') {
    if (authRateLimited(req)) return json(res, 429, { error: '尝试次数过多，请 10 分钟后再试。' });
    try {
      const body = JSON.parse(await readBody(req));
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const rememberMe = Boolean(body.rememberMe);
      const user = findUserByUsername(username);
      if (!user || user.disabled || !passwordMatches(user, password)) {
        recordAuthFailure(req);
        return json(res, 401, { error: '用户名或密码不正确。' });
      }
      user.lastLoginAt = now();
      persistUsers();
      clearAuthFailures(req);
      setSessionCookie(res, createSession(user, rememberMe), rememberMe);
      return json(res, 200, { user: publicUser(user) });
    } catch (error) {
      return json(res, 400, { error: error.message || '登录失败。' });
    }
  }

  if (pathname === `${api}/auth/logout` && req.method === 'POST') {
    const token = parseCookies(req).codex_session;
    if (token) sessions.delete(sessionHash(token));
    persistSessions();
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }

  const authUser = currentUser(req);
  if (pathname === `${api}/auth/me` && req.method === 'GET') {
    if (!authUser) return json(res, 401, { error: '请先登录。' });
    return json(res, 200, { user: publicUser(authUser) });
  }

  if (pathname === `${api}/admin/users` && req.method === 'GET') {
    if (!authUser) return json(res, 401, { error: '请先登录。' });
    if (authUser.role !== 'admin') return json(res, 403, { error: '需要管理员权限。' });
    return json(res, 200, { users: users.map(publicUser) });
  }

  if (pathname === `${api}/admin/registration-keys` && req.method === 'POST') {
    if (!authUser) return json(res, 401, { error: '请先登录。' });
    if (authUser.role !== 'admin') return json(res, 403, { error: '需要管理员权限。' });
    return json(res, 201, { key: createRegistrationKey(), oneTime: true });
  }

  const adminUserPath = `${api}/admin/users/`;
  if (pathname.startsWith(adminUserPath) && req.method === 'PATCH') {
    if (!authUser) return json(res, 401, { error: '请先登录。' });
    if (authUser.role !== 'admin') return json(res, 403, { error: '需要管理员权限。' });
    const userId = decodeURIComponent(pathname.slice(adminUserPath.length));
    const target = users.find(item => item.id === userId);
    if (!target) return json(res, 404, { error: '用户不存在。' });
    if (target.id === authUser.id) return json(res, 400, { error: '不能禁用当前管理员账号。' });
    try {
      const body = JSON.parse(await readBody(req));
      target.disabled = Boolean(body.disabled);
      persistUsers();
      for (const [tokenHash, session] of sessions) {
        if (session.userId === target.id && target.disabled) sessions.delete(tokenHash);
      }
      persistSessions();
      return json(res, 200, { user: publicUser(target) });
    } catch (error) {
      return json(res, 400, { error: error.message || '用户状态保存失败。' });
    }
  }

  if (pathname.startsWith(api) && !authUser) {
    return json(res, 401, { error: '请先登录。' });
  }

  if (pathname === `${api}/health`) {
    return json(res, 200, { ok: true, running: activeRuns.size > 0, conversations: conversations.filter(item => canAccessConversation(item, authUser)).length });
  }

  if (pathname === `${api}/models` && req.method === 'GET') {
    return json(res, 200, {
      defaultModel: DEFAULT_MODEL,
      defaultReasoningEffort: normalizeSettings(DEFAULT_MODEL, DEFAULT_REASONING).reasoningEffort,
      models: MODEL_CATALOG
    });
  }

  if (pathname === `${api}/conversations` && req.method === 'GET') {
    sortConversations();
    return json(res, 200, { conversations: conversations.filter(item => canAccessConversation(item, authUser)).map(conversationSummary) });
  }

  if (pathname === `${api}/conversations` && req.method === 'POST') {
    try {
      const bodyText = await readBody(req);
      const body = bodyText ? JSON.parse(bodyText) : {};
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, 60) : '新对话';
      return json(res, 201, {
        conversation: publicConversation(createConversation(title || '新对话', {
          model: body.model,
          reasoningEffort: body.reasoningEffort
        }, authUser.id))
      });
    } catch (error) {
      return json(res, 400, { error: error.message || '创建对话失败。' });
    }
  }

  const conversationPath = `${api}/conversations/`;
  if (pathname.startsWith(conversationPath)) {
    const tail = decodeURIComponent(pathname.slice(conversationPath.length));
    const [id, subpath] = tail.split('/');
    const conversation = findConversation(id, authUser);
    if (!conversation) return json(res, 404, { error: '对话不存在。' });
    if (subpath === 'settings' && req.method === 'PATCH') {
      try {
        const body = JSON.parse(await readBody(req));
        const settings = normalizeSettings(body.model, body.reasoningEffort);
        conversation.model = settings.model;
        conversation.reasoningEffort = settings.reasoningEffort;
        conversation.updatedAt = now();
        persist();
        return json(res, 200, { conversation: publicConversation(conversation) });
      } catch (error) {
        return json(res, 400, { error: error.message || '模型设置保存失败。' });
      }
    }
    if (subpath === 'branch' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req));
        const branch = branchConversation(conversation, typeof body.messageId === 'string' ? body.messageId : '', authUser.id);
        return json(res, 201, { conversation: publicConversation(branch) });
      } catch (error) {
        return json(res, 400, { error: error.message || '创建分支失败。' });
      }
    }
    if (subpath) return json(res, 404, { error: '对话接口不存在。' });
    if (req.method === 'GET') return json(res, 200, { conversation: publicConversation(conversation) });
    if (req.method === 'DELETE') {
      deleteStoredImages(conversation);
      conversations = conversations.filter(item => item.id !== id);
      persist();
      return json(res, 200, { ok: true });
    }
  }

  const imagePath = `${api}/images/`;
  if (pathname.startsWith(imagePath) && req.method === 'GET') {
    const id = decodeURIComponent(pathname.slice(imagePath.length));
    if (!/^[a-z0-9-]+\.(png|jpg|gif)$/i.test(id)) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    const image = imageById(id, authUser);
    if (!image || !fs.existsSync(image.path)) return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    return send(res, 200, image.type, fs.readFileSync(image.path), { 'Cache-Control': 'private, max-age=3600' });
  }

  if (pathname === `${api}/chat/stream` && req.method === 'POST') {
    let headersSent = false;
    let conversation = null;
    const runEvents = [];
    let runEventBytes = 0;
    const rememberRunEvent = event => {
      const saved = compactRunEvent(event);
      if (saved && runEvents.length < MAX_RUN_EVENTS) {
        const size = Buffer.byteLength(JSON.stringify(saved));
        if (runEventBytes + size <= MAX_RUN_STORAGE_BYTES) {
          runEvents.push(saved);
          runEventBytes += size;
        }
      }
    };
    const emitAndRemember = event => {
      rememberRunEvent(event);
      emitStreamEvent(res, event);
    };
    try {
      const body = JSON.parse(await readBody(req));
      conversation = findConversation(typeof body.conversationId === 'string' ? body.conversationId : '', authUser);
      if (!conversation) return json(res, 404, { error: '对话不存在，请新建一个对话。' });
      const runKey = conversation.id;
      if (activeRuns.has(runKey)) return json(res, 409, { error: '这个对话的上一条消息还在处理中，请稍等。' });
      if (body.model || body.reasoningEffort) {
        const settings = normalizeSettings(body.model || conversation.model, body.reasoningEffort || conversation.reasoningEffort);
        conversation.model = settings.model;
        conversation.reasoningEffort = settings.reasoningEffort;
      }
      const settings = ensureSettings(conversation);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message && !body.images?.length) return json(res, 400, { error: '消息或图片不能为空。' });
      if (message.length > MAX_MESSAGE_CHARS) return json(res, 400, { error: '消息不能超过 12000 个字符。' });

      const savedImages = parseImages(body.images);
      const promptMessage = message || '请分析我上传的图片。';
      const readOnly = authUser.role !== 'admin';
      const prompt = buildPrompt(conversation, promptMessage, savedImages, { readOnly });
      const userMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        text: message,
        images: savedImages,
        createdAt: now()
      };
      updateInitialConversationTitle(conversation, message);
      conversation.messages.push(userMessage);
      conversation.updatedAt = now();
      persist();

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      headersSent = true;
      emitStreamEvent(res, { type: 'accepted', messageId: userMessage.id });
      emitAndRemember({ type: 'status', text: '正在启动 Codex' });

      const contextImages = conversation.messages
        .slice(-10)
        .flatMap(item => item.images || [])
        .slice(-6);
      const result = await runCodexStream(prompt, contextImages, settings, emitAndRemember, { readOnly, runKey });
      const assistantMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: result.answer,
        images: [],
        createdAt: now(),
        runEvents: runEvents.slice(0, MAX_RUN_EVENTS)
      };
      conversation.messages.push(assistantMessage);
      conversation.updatedAt = now();
      sortConversations();
      persist();
      emitStreamEvent(res, { type: 'final', answer: result.answer, message: publicMessage(assistantMessage), conversation: conversationSummary(conversation) });
      emitStreamEvent(res, { type: 'done' });
      res.end();
      return;
    } catch (error) {
      const errorText = error.message || 'Codex 执行失败。';
      const errorEvent = { type: 'error', text: errorText };
      rememberRunEvent(errorEvent);
      const errorMessage = saveErrorMessage(conversation, errorText, runEvents);
      if (!headersSent) return json(res, 500, { error: errorText, message: errorMessage ? publicMessage(errorMessage) : null });
      emitStreamEvent(res, {
        ...errorEvent,
        text: errorText,
        message: errorMessage ? publicMessage(errorMessage) : null,
        conversation: conversation ? conversationSummary(conversation) : null
      });
      emitStreamEvent(res, { type: 'done' });
      return res.end();
    }
  }

  if (pathname === `${api}/chat/stop` && req.method === 'POST') {
    let body = {};
    try {
      const bodyText = await readBody(req);
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {}
    let runKey = typeof body.conversationId === 'string' ? body.conversationId : '';
    let run = runKey ? activeRuns.get(runKey) : null;
    if (!run) {
      const accessibleRuns = [...activeRuns.entries()].filter(([id]) => {
        const conversation = findConversation(id, authUser);
        return Boolean(conversation);
      });
      if (accessibleRuns.length === 1) {
        [runKey, run] = accessibleRuns[0];
      }
    }
    if (!run) return json(res, 200, { ok: false, message: '当前没有正在运行的任务。' });
    if (!findConversation(runKey, authUser)) return json(res, 404, { error: '对话不存在。' });
    run.stop();
    return json(res, 200, { ok: true, message: '正在停止当前任务。' });
  }

  if (pathname === `${api}/chat` && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const conversation = findConversation(typeof body.conversationId === 'string' ? body.conversationId : '', authUser);
      if (!conversation) return json(res, 404, { error: '对话不存在，请新建一个对话。' });
      const runKey = conversation.id;
      if (activeRuns.has(runKey)) return json(res, 409, { error: '这个对话的上一条消息还在处理中，请稍等。' });
      if (body.model || body.reasoningEffort) {
        const settings = normalizeSettings(body.model || conversation.model, body.reasoningEffort || conversation.reasoningEffort);
        conversation.model = settings.model;
        conversation.reasoningEffort = settings.reasoningEffort;
      }
      const settings = ensureSettings(conversation);
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      if (!message && !body.images?.length) return json(res, 400, { error: '消息或图片不能为空。' });
      if (message.length > MAX_MESSAGE_CHARS) return json(res, 400, { error: '消息不能超过 12000 个字符。' });

      const savedImages = parseImages(body.images);
      const promptMessage = message || '请分析我上传的图片。';
      const readOnly = authUser.role !== 'admin';
      const prompt = buildPrompt(conversation, promptMessage, savedImages, { readOnly });
      const userMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        text: message,
        images: savedImages,
        createdAt: now()
      };
      updateInitialConversationTitle(conversation, message);
      conversation.messages.push(userMessage);
      conversation.updatedAt = now();
      persist();

      const contextImages = conversation.messages
        .slice(-10)
        .flatMap(item => item.images || [])
        .slice(-6);
      const answer = await runCodex(prompt, contextImages, settings, { readOnly, runKey });
      const assistantMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        text: answer,
        images: [],
        createdAt: now()
      };
      conversation.messages.push(assistantMessage);
      conversation.updatedAt = now();
      sortConversations();
      persist();
      return json(res, 200, { answer, message: publicMessage(assistantMessage), conversation: conversationSummary(conversation) });
    } catch (error) {
      return json(res, 500, { error: error.message || 'Codex 执行失败。' });
    }
  }

  send(res, 404, 'text/plain; charset=utf-8', 'Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Codex web UI listening on http://${HOST}:${PORT}${BASE_PATH}/`);
});

if (fs.existsSync(HTTPS_KEY_FILE) && fs.existsSync(HTTPS_CERT_FILE)) {
  const httpsServer = https.createServer({
    key: fs.readFileSync(HTTPS_KEY_FILE),
    cert: fs.readFileSync(HTTPS_CERT_FILE)
  }, server.listeners('request')[0]);
  httpsServer.listen(HTTPS_PORT, HOST, () => {
    console.log(`Codex web UI listening on https://${HOST}:${HTTPS_PORT}${BASE_PATH}/`);
  });
} else {
  console.warn(`HTTPS certificate files not found; HTTPS listener is disabled.`);
}
