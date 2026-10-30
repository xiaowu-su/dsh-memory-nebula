/**
 * dsh-memory-nebula — Host half.
 *
 * Reads the long-term-memory Markdown vault, exposes a small JSON/SSE API on
 * the DSH web server, and serves the 3D nebula page used by the sidebar panel.
 * New memory notes are picked up by polling; SSE tells the page to resync.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const inject = ['webServer'];

const ROUTE = '/memory-nebula';
const VIEW_PATH = fileURLToPath(new URL('./view.html', import.meta.url));
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_AVATAR = join(PLUGIN_DIR, 'assets', 'avatar.png');
const FALLBACK_AVATAR = join(PLUGIN_DIR, 'icon.svg');
const SKIP_DIRS = new Set(['.dsh-memory', '.obsidian', 'Index', 'History', 'Inbox', 'Conflicts']);
const SKIP_FILES = new Set(['README.md', 'Memory Home.md']);
const IMAGE_TYPES = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.webp':'image/webp', '.gif':'image/gif', '.svg':'image/svg+xml' };
const IMAGE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function expandHome(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (raw === '~') return homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homedir(), raw.slice(2));
  return raw;
}

function isDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function firstExistingDir(list, fallback) {
  return list.filter(Boolean).find(isDir) || fallback;
}

function resolveVaultPath(raw, env = process.env) {
  if (typeof raw === 'string' && raw.trim()) return resolve(expandHome(raw));
  const home = homedir();
  const oneDrive = env.OneDrive || env.OneDriveConsumer || env.OneDriveCommercial;
  const docs = env.DSH_MEMORY_DOCUMENTS_DIR
    ? resolve(expandHome(env.DSH_MEMORY_DOCUMENTS_DIR))
    : oneDrive
      ? join(expandHome(oneDrive), 'Documents')
      : join(home, 'Documents');
  const candidates = [
    env.DSH_MEMORY_VAULT ? resolve(expandHome(env.DSH_MEMORY_VAULT)) : '',
    env.DSH_MEMORY_DOCUMENTS_DIR ? join(docs, 'DSH Memory') : '',
    join(docs, 'DSH Memory'),
    join(home, 'DSH Memory'),
  ].filter(Boolean);
  // Prefer a real DSH Memory Vault (its marker / home note) over an arbitrary folder.
  const marked = candidates.find((p) => isDir(p) && (existsSync(join(p, '.dsh-memory', 'config.json')) || existsSync(join(p, 'Memory Home.md'))));
  if (marked) return marked;
  return firstExistingDir(candidates, candidates[0]);
}

function resolveSessionDir(raw, env = process.env) {
  if (typeof raw === 'string' && raw.trim()) return resolve(expandHome(raw));
  const home = homedir();
  const dshHome = resolve(env.DSH_HOME || join(home, '.dsh'));
  const candidates = [
    env.DSH_SESSION_DIR ? resolve(expandHome(env.DSH_SESSION_DIR)) : '',
    join(dshHome, 'storages', 'session_projcache', 'sessions'),
    join(dshHome, 'sessions'),
    join(dshHome, 'storages', 'sessions'),
  ].filter(Boolean);
  return firstExistingDir(candidates, candidates[0]);
}

function pickAvatarFile(candidate) {
  if (!candidate) return '';
  let st;
  try { st = statSync(candidate); } catch { return ''; }
  if (st.isFile()) return candidate;
  if (!st.isDirectory()) return '';
  for (const name of ['03-avatar.png', 'avatar.png', 'avatar.jpg', 'avatar.jpeg', 'avatar.webp', 'avatar.svg']) {
    const file = join(candidate, name);
    if (existsSync(file)) return file;
  }
  return '';
}

function resolveAvatar(raw) {
  if (typeof raw === 'string' && raw.trim()) {
    const candidate = resolve(expandHome(raw));
    return pickAvatarFile(candidate) || candidate;
  }
  return pickAvatarFile(DEFAULT_AVATAR) || pickAvatarFile(FALLBACK_AVATAR);
}

function parseExtraRoots(raw) {
  if (Array.isArray(raw)) return raw.map(String).map(expandHome).map((v) => v.trim()).filter(Boolean);
  return String(raw ?? '').split(/[\n,;]+/).map(expandHome).map((v) => v.trim()).filter(Boolean);
}

function resolveImageRoots(raw, vaultPath, avatarPath, dshHome, env = process.env) {
  const home = homedir();
  const roots = [
    vaultPath,
    PLUGIN_DIR,
    join(PLUGIN_DIR, 'assets'),
    join(resolve(dshHome || env.DSH_HOME || join(home, '.dsh')), 'media'),
    join(resolve(dshHome || env.DSH_HOME || join(home, '.dsh')), 'meme-packs'),
    join(home, 'Pictures'),
    join(home, 'Downloads'),
  ];
  if (avatarPath) roots.push(dirname(avatarPath));
  for (const extra of parseExtraRoots(raw)) roots.push(resolve(extra));
  return [...new Set(roots.filter(Boolean))];
}

function avatarInfo(avatarPath) {
  if (!avatarPath) return { path: '', url: '' };
  try {
    const st = statSync(avatarPath);
    if (!st.isFile()) return { path: '', url: '' };
    return { path: avatarPath, url: ROUTE + '/avatar?v=' + Math.round(st.mtimeMs) };
  } catch { return { path: '', url: '' }; }
}

const CLUSTER_BY_TYPE = {
  identity: 'heart',
  profile: 'heart',
  preference: 'rules',
  archive: 'dust',
  project: 'infra',
  'project-state': 'infra',
  knowledge: 'infra',
  decision: 'infra',
  state: 'infra',
  task: 'rules',
};

function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md') && !SKIP_FILES.has(entry.name)) {
      out.push(full);
    }
  }
}

function unquote(value) {
  const s = value.trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1).replace(/\\"/g, '"');
  }
  return s;
}

function frontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const value = unquote(m[2]);
    if (value !== '') fields[m[1]] = value;
  }
  return fields;
}

function readTags(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return [];
  const lines = match[1].split(/\r?\n/);
  const out = [];
  let inTags = false;
  for (const line of lines) {
    if (/^tags\s*:\s*$/.test(line)) { inTags = true; continue; }
    const inline = /^tags\s*:\s*\[(.*)\]\s*$/.exec(line);
    if (inline) {
      for (const part of inline[1].split(',')) {
        const tag = unquote(part);
        if (tag) out.push(tag);
      }
      continue;
    }
    if (!inTags) continue;
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (item) { const tag = unquote(item[1]); if (tag) out.push(tag); continue; }
    if (/^\S/.test(line)) inTags = false;
  }
  return [...new Set(out)];
}

function readSourceSessions(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return [];
  const lines = match[1].split(/\r?\n/);
  const out = [];
  let inList = false;
  for (const line of lines) {
    if (/^source_sessions\s*:\s*$/.test(line)) { inList = true; continue; }
    if (!inList) continue;
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (item) { const v = unquote(item[1]); if (v) out.push(v); continue; }
    if (/^\S/.test(line)) inList = false;
  }
  return [...new Set(out)];
}

function shortLabel(title) {
  let s = title
    .replace(/^用户偏好[:：]\s*/, '')
    .replace(/^用户背景[:：]\s*/, '')
    .replace(/^经验教训[:：]\s*/, '')
    .trim();
  if (s.length > 14) s = s.slice(0, 13) + '…';
  return s || title;
}

const KNOWN_CLUSTER = {
  prof03:'heart', '1138ca23':'heart', '677efa47':'heart',
  '1a2850ae':'rules', '7c070f13':'rules', '442e4efa':'rules', '8de44335':'rules', 'be8ea175':'rules',
  '743995c0':'qzone', 'dac2b99b':'qzone', '20ef32b7':'qzone', '7e2918ef':'qzone', '7fac124b':'qzone',
  '7fe637ef':'relay', 'ae6dfb0c':'relay', '077bd046':'relay', 'daa0b518':'relay',
  loop403:'infra', 'a5f2d3ab':'infra', patchstate:'infra', noviking:'infra', '94517b8f':'infra',
  bc8343b6:'dust', '337b2f0f':'dust'
};

function assignCluster(type, title, text, id) {
  const key = String(id || '').includes('_') ? String(id).slice(String(id).lastIndexOf('_') + 1) : String(id || '');
  if (KNOWN_CLUSTER[key]) return KNOWN_CLUSTER[key];
  if (type === 'profile' || type === 'identity') return 'heart';
  if (type === 'archive') return 'dust';
  if (type === 'preference') return 'rules';
  if (type === 'project' || type === 'project-state' || type === 'knowledge' || type === 'decision' || type === 'state') return 'infra';
  if (type === 'experience') {
    const blob = `${title} ${text.slice(0, 500)}`;
    if (/(说说|空间|qzone)/i.test(blob)) return 'qzone';
    if (/(表情|图库|onebot|media|发图|发送|qq)/i.test(blob)) return 'relay';
    if (/(插件|dsh|路由|端口|host|服务|403)/i.test(blob)) return 'infra';
    return 'relay';
  }
  return 'rules';
}

function plainText(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, ' ')
    .replace(/^\s*-{3,}\s*$/gm, ' ')
    .replace(/[#>*_`~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSummary(text) {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const section = /##\s*核心内容\s*\n([\s\S]*?)(?=\n##\s|$)/.exec(body);
  let source = section ? section[1] : body;
  source = plainText(source);
  if (source.length > 260) source = source.slice(0, 257) + '…';
  return source;
}

function insideRoots(file, roots) {
  const norm = (value) => {
    let out = resolve(value);
    if (process.platform === 'win32') out = out.toLowerCase();
    return out;
  };
  const target = norm(file);
  return roots.some((root) => {
    const base = norm(root);
    return target === base || target.startsWith(base + sep);
  });
}

function extractImages(text, file, vaultPath, fields, imageRoots) {
  const candidates = [];
  for (const match of text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    candidates.push({ src: match[2], alt: match[1] || '' });
  }
  for (const key of ['image', 'images']) {
    if (!fields[key]) continue;
    for (const part of String(fields[key]).split(/[,\s]+/)) {
      if (part) candidates.push({ src: part, alt: '' });
    }
  }
  for (const match of text.matchAll(/(?:^|[\s(（"'`])((?:[A-Za-z]:[\\/]|\/(?:root|home|Users|mnt|media|tmp)\/)[^\s)）"'`]+\.(?:png|jpe?g|webp|gif))/gi)) {
    candidates.push({ src: match[1], alt: '' });
  }
  const out = [];
  const seen = new Set();
  for (const item of candidates) {
    let src = String(item.src || '').trim().replace(/^file:\/\//, '');
    if (!src) continue;
    if (/^https?:\/\//i.test(src)) {
      if (!seen.has(src)) { seen.add(src); out.push({ src, alt: item.alt || '' }); }
      continue;
    }
    src = src.replace(/^['"]|['"]$/g, '');
    let abs = /^[A-Za-z]:[\\/]/.test(src) || src.startsWith('/') ? src : resolve(dirname(file), src);
    if (!existsSync(abs)) abs = resolve(vaultPath, src);
    if (!existsSync(abs) || !insideRoots(abs, imageRoots)) continue;
    try { if (!statSync(abs).isFile()) continue; } catch { continue; }
    const route = '/memory-nebula/image?path=' + encodeURIComponent(abs);
    if (!seen.has(route)) { seen.add(route); out.push({ src: route, alt: item.alt || '' }); }
    if (out.length >= 3) break;
  }
  return out;
}

function readMemory(file, coreSeen, vaultPath, imageRoots) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch { return null; }
  const fields = frontmatter(text);
  if (!fields || !fields.id || !fields.id.startsWith('mem_')) return null;
  const title = fields.title || fields.id;
  const status = ['active', 'archived', 'stale'].includes(fields.status) ? fields.status : 'active';
  let type = fields.type || 'experience';
  if (type === 'profile') type = 'identity';
  else if (type === 'project-state') type = 'state';
  else if (type === 'task') type = 'project';
  if (status === 'archived') type = 'archive';
  const created = fields.created_at || new Date(statSync(file).mtimeMs).toISOString();
  const imp = Number.parseInt(fields.importance || '65', 10);
  const core = fields.type === 'profile' && fields.pinned === 'true' && !coreSeen.value;
  if (core) coreSeen.value = true;
  return {
    id: fields.id,
    type,
    status,
    imp: Number.isFinite(imp) ? Math.max(0, Math.min(100, imp)) : 65,
    title,
    full: title,
    label: shortLabel(title),
    date: created.slice(0, 10),
    created,
    summary: extractSummary(text),
    tags: readTags(text),
    sourceSessions: readSourceSessions(text),
    images: extractImages(text, file, vaultPath, fields, imageRoots),
    cluster: assignCluster(type, title, text, fields.id),
    core,
    file,
  };
}

const CLUSTER_NAMES = { heart:'鲸心', rules:'雪的规矩', qzone:'说说轨道', relay:'传讯星域', infra:'本机基建', dust:'旧星尘' };
const TYPE_NAMES = { identity:'身份', preference:'偏好', experience:'经验', project:'项目', knowledge:'知识', decision:'决策', state:'状态', archive:'归档' };
const IGNORE_TAGS = new Set(['preference','experience','project-state','state','knowledge','decision','project','profile','identity','archive','dsh','03','user','persona']);

function linkRelations(memories) {
  for (const m of memories) {
    const ownTags = (m.tags || []).filter(t => !IGNORE_TAGS.has(String(t).toLowerCase()));
    const candidates = [];
    for (const o of memories) {
      if (o.id === m.id) continue;
      const otherTags = (o.tags || []).filter(t => !IGNORE_TAGS.has(String(t).toLowerCase()));
      const shared = ownTags.filter(t => otherTags.includes(t));
      const reasons = [];
      let score = 0;
      if (shared.length) {
        score += shared.length * 4;
        reasons.push('同标签：' + shared.slice(0, 2).join('、'));
      }
      if (o.cluster === m.cluster) {
        score += 1.5;
        reasons.push('同采集区：' + (CLUSTER_NAMES[m.cluster] || m.cluster));
      }
      if (o.type === m.type) { score += 0.6; reasons.push('同类型：' + (TYPE_NAMES[m.type] || m.type)); }
      if (score > 0) candidates.push({ id: o.id, score, reason: reasons.join(' · ') });
    }
    candidates.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
    let picked = candidates.slice(0, 4);
    if (!picked.length) {
      const same = memories
        .filter(o => o.id !== m.id && o.cluster === m.cluster)
        .sort((a, b) => Math.abs(Date.parse(a.created) - Date.parse(m.created)) - Math.abs(Date.parse(b.created) - Date.parse(m.created)));
      if (same.length) {
        picked = [{ id: same[0].id, reason: '同采集区：' + (CLUSTER_NAMES[m.cluster] || m.cluster) }];
      } else {
        const any = memories
          .filter(o => o.id !== m.id)
          .sort((a, b) => Math.abs(Date.parse(a.created) - Date.parse(m.created)) - Math.abs(Date.parse(b.created) - Date.parse(m.created)));
        if (any.length) picked = [{ id: any[0].id, reason: '时间相近' }];
      }
    }
    m.related = picked.map(x => ({ id: x.id, reason: x.reason || '同记忆库' }));
  }
}

function readSessions(sessionDir, memories) {
  const out = [];
  let files = [];
  try { files = readdirSync(sessionDir).filter(f => f.endsWith('.json')); }
  catch { return { sessions: [], sig: '' }; }
  const sig = [];
  for (const file of files) {
    const full = join(sessionDir, file);
    let st;
    try { st = statSync(full); } catch { continue; }
    sig.push(`${full}:${st.mtimeMs}:${st.size}`);
    let record;
    try { record = JSON.parse(readFileSync(full, 'utf8'))?.record; } catch { continue; }
    if (!record || typeof record !== 'object') continue;
    const id = file.slice(0, -5);
    const title = record.rows?.title?.val || record.rows?.titleInput?.val?.first?.text || '';
    const created = record.identity?.createdAt || st.birthtimeMs || st.mtimeMs;
    out.push({
      id,
      title: String(title || '').trim(),
      cwd: record.identity?.cwd || '',
      created,
      updated: st.mtimeMs,
    });
  }
  if (!out.length) return { sessions: [], sig: sig.join('\n') };
  // Every session file is a satellite: no cap, no "recent 12" filter.
  const chosen = out;
  for (const s of chosen) {
    s.memories = [];
    s.title = s.title || ('会话 ' + s.id.slice(-6));
  }
  const sessionById = new Map(chosen.map(s => [s.id, s]));
  for (const m of memories) {
    const direct = (m.sourceSessions || []).filter(id => sessionById.has(id));
    if (direct.length) {
      for (const id of direct) sessionById.get(id).memories.push(m.id);
      continue;
    }
    let best = null, bd = Infinity;
    for (const s of chosen) {
      const d = Math.abs((s.created || 0) - Date.parse(m.created || 0));
      if (d < bd) { bd = d; best = s; }
    }
    if (best) best.memories.push(m.id);
  }
  for (const s of chosen) {
    s.memories = [...new Set(s.memories)];
    if (!s.memories.length) {
      let best = null, bd = Infinity;
      for (const m of memories) {
        const d = Math.abs((s.created || 0) - Date.parse(m.created || 0));
        if (d < bd) { bd = d; best = m; }
      }
      if (best) s.memories.push(best.id);
    }
    delete s.cwd;
    delete s.updated;
  }
  return {
    sessions: chosen.map(s => ({
      id: s.id, title: s.title, created: s.created, memories: s.memories,
    })),
    sig: sig.join('\n'),
  };
}

function scanVault(vaultPath, sessionDir, imageRoots) {
  const files = [];
  walk(vaultPath, files);
  const coreSeen = { value: false };
  const memories = [];
  let sigParts = [];
  for (const file of files) {
    let st;
    try { st = statSync(file); } catch { continue; }
    sigParts.push(`${file}:${st.mtimeMs}:${st.size}`);
    const memory = readMemory(file, coreSeen, vaultPath, imageRoots);
    if (memory) memories.push(memory);
  }
  memories.sort((a, b) => String(a.created).localeCompare(String(b.created)));
  linkRelations(memories);
  const sessionData = readSessions(sessionDir, memories);
  return {
    ok: true,
    vaultPath,
    memories,
    sessions: sessionData.sessions,
    count: memories.length,
    sig: sigParts.join('\n') + '\n' + sessionData.sig,
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}


async function loadConfig() {
  let z;
  try {
    ({ default: z } = await import('@deepseek-ai/schemastery'));
  } catch {
    return undefined;
  }
  const describe = (schema, text) => {
    try { return typeof schema.description === 'function' ? schema.description(text) : schema; }
    catch { return schema; }
  };
  return z.object({
    vaultPath: describe(z.string().default(''), '长期记忆库目录；留空自动检测 DSH Memory（推荐）'),
    sessionDir: describe(z.string().default(''), 'DSH 会话目录；留空自动检测 $DSH_HOME/storages/session_projcache/sessions'),
    avatarPath: describe(z.string().default(''), '头像文件或目录；留空使用插件 assets/avatar.png'),
    imageRoots: describe(z.string().default(''), '额外图片根目录，换行或逗号分隔'),
    coreLabel: describe(z.string().default('鲸心 · 03'), '中心鲸心的显示标题'),
    pollMs: describe(z.number().min(800).max(30000).default(2500), '记忆库轮询间隔（毫秒）'),
  });
}

export const Config = await loadConfig();

function settingsFilePath(env = process.env) {
  return join(resolve(env.DSH_HOME || join(homedir(), '.dsh')), 'plugins-data', 'dsh-memory-nebula', 'settings.json');
}

function readSavedSettings(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(settingsFilePath(env), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function saveSettings(values, env = process.env) {
  const file = settingsFilePath(env);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(values, null, 2) + '\n', 'utf8');
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('body too large')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function apply(ctx, config = {}) {
  const saved = readSavedSettings();
  let current = { ...config, ...saved };
  let vaultPath = '';
  let sessionDir = '';
  let avatarPath = '';
  let imageRoots = [];
  let pollMs = 2500;
  let pollTimer = null;
  function applyPortablePaths() {
    vaultPath = resolveVaultPath(current.vaultPath);
    sessionDir = resolveSessionDir(current.sessionDir);
    avatarPath = resolveAvatar(current.avatarPath);
    imageRoots = resolveImageRoots(current.imageRoots, vaultPath, avatarPath, process.env.DSH_HOME);
    const nextPoll = Number(current.pollMs);
    pollMs = Number.isFinite(nextPoll) && nextPoll >= 800 ? Math.min(30000, Math.round(nextPoll)) : 2500;
  }
  applyPortablePaths();
  function effectiveCoreLabel() {
    return typeof current.coreLabel === 'string' && current.coreLabel.trim() ? current.coreLabel.trim() : '鲸心 · 03';
  }
  function settingsValues() {
    return {
      vaultPath: typeof current.vaultPath === 'string' ? current.vaultPath : '',
      sessionDir: typeof current.sessionDir === 'string' ? current.sessionDir : '',
      avatarPath: typeof current.avatarPath === 'string' ? current.avatarPath : '',
      imageRoots: typeof current.imageRoots === 'string' ? current.imageRoots : '',
      coreLabel: typeof current.coreLabel === 'string' ? current.coreLabel : '',
      pollMs,
    };
  }
  function settingsPayload() {
    return {
      ok: true,
      values: settingsValues(),
      effective: { vaultPath, sessionDir, avatarPath, imageRoots, coreLabel: effectiveCoreLabel(), pollMs },
      detected: {
        vaultPath: resolveVaultPath(''),
        sessionDir: resolveSessionDir(''),
        avatarPath: resolveAvatar(''),
      },
      settingsFile: settingsFilePath(),
    };
  }
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      const next = refresh();
      if (next.sig !== last.sig) {
        last = next;
        broadcast();
      }
    }, pollMs);
  }
  const clients = new Set();
  let last = { ok: true, vaultPath, memories: [], sessions: [], count: 0, sig: '', updatedAt: Date.now() };

  ctx.logger?.info?.('memory-nebula: vault=%s sessions=%s avatar=%s', vaultPath, sessionDir, avatarPath || '(none)');
  if (!isDir(vaultPath)) ctx.logger?.warn?.('memory-nebula: vault directory does not exist: %s', vaultPath);
  if (!isDir(sessionDir)) ctx.logger?.warn?.('memory-nebula: session directory does not exist: %s', sessionDir);

  function refresh() {
    const next = scanVault(vaultPath, sessionDir, imageRoots);
    next.updatedAt = Date.now();
    return next;
  }

  function broadcast() {
    const payload = JSON.stringify({
      type: 'changed',
      count: last.count,
      updatedAt: last.updatedAt,
      vaultPath,
    });
    for (const client of clients) {
      try { client.res.write(`data: ${payload}\n\n`); }
      catch { clearInterval(client.timer); clients.delete(client); }
    }
  }

  function openEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2500\n\n');
    const client = { res, timer: null };
    client.timer = setInterval(() => {
      try { res.write(': ping\n\n'); }
      catch { clearInterval(client.timer); clients.delete(client); }
    }, 20000);
    clients.add(client);
    const close = () => {
      clearInterval(client.timer);
      clients.delete(client);
      try { res.end(); } catch { /* already closed */ }
    };
    req.on('close', close);
    res.on('close', close);
    try {
      res.write(`data: ${JSON.stringify({ type: 'hello', count: last.count, vaultPath, avatarUrl: avatarInfo(avatarPath).url })}\n\n`);
    } catch { /* connection went away */ }
  }

  const webServer = ctx.get('webServer');
  if (webServer === undefined || typeof webServer.register !== 'function') {
    ctx.logger?.warn?.('memory-nebula: ctx.webServer is unavailable; page and API are not mounted');
    return;
  }

  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://memory-nebula.local');
      const path = url.pathname;
      if (path === `${ROUTE}/api`) {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'GET only' }); return; }
        const snap = refresh();
        last = snap;
        const avatar = avatarInfo(avatarPath);
        sendJson(res, 200, {
          ok: true,
          vaultPath,
          sessionDir,
          avatarUrl: avatar.url,
          coreLabel: effectiveCoreLabel(),
          count: snap.count,
          sessions: snap.sessions,
          updatedAt: snap.updatedAt,
          memories: snap.memories,
        });
        return;
      }
      if (path === `${ROUTE}/events`) {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'GET only' }); return; }
        openEvents(req, res);
        return;
      }
      if (path === `${ROUTE}/avatar`) {
        const info = avatarInfo(avatarPath);
        if (!info.path) { sendJson(res, 404, { ok: false, error: 'avatar not configured' }); return; }
        const type = IMAGE_TYPES[extname(info.path).toLowerCase()];
        if (!type) { sendJson(res, 415, { ok: false, error: 'unsupported avatar type' }); return; }
        let avatarStat;
        try { avatarStat = statSync(info.path); } catch { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
        if (!avatarStat.isFile() || avatarStat.size > 8 * 1024 * 1024) { sendJson(res, 413, { ok: false, error: 'file too large' }); return; }
        try {
          const data = readFileSync(info.path);
          res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': data.length,
            'Cache-Control': 'private, max-age=60',
            ...IMAGE_SECURITY_HEADERS,
          });
          res.end(data);
        } catch {
          sendJson(res, 500, { ok: false, error: 'read failed' });
        }
        return;
      }
      if (path === `${ROUTE}/settings`) {
        if (req.method === 'GET') {
          sendJson(res, 200, settingsPayload());
          return;
        }
        if (req.method === 'POST') {
          let body;
          try { body = JSON.parse(await readBody(req)); }
          catch { sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); return; }
          if (!body || typeof body !== 'object') { sendJson(res, 400, { ok: false, error: 'invalid settings' }); return; }
          current = {
            vaultPath: typeof body.vaultPath === 'string' ? body.vaultPath.trim() : '',
            sessionDir: typeof body.sessionDir === 'string' ? body.sessionDir.trim() : '',
            avatarPath: typeof body.avatarPath === 'string' ? body.avatarPath.trim() : '',
            imageRoots: typeof body.imageRoots === 'string' ? body.imageRoots.trim() : '',
            coreLabel: typeof body.coreLabel === 'string' ? body.coreLabel.trim() : '',
            pollMs: Number(body.pollMs) || 2500,
          };
          try { saveSettings(current); }
          catch (error) { sendJson(res, 500, { ok: false, error: 'cannot save settings: ' + String(error?.message ?? error) }); return; }
          applyPortablePaths();
          last = refresh();
          broadcast();
          startPolling();
          sendJson(res, 200, settingsPayload());
          return;
        }
        sendJson(res, 405, { ok: false, error: 'GET or POST only' });
        return;
      }
      if (path === `${ROUTE}/config`) {
        sendJson(res, 200, {
          ok: true,
          vaultPath,
          sessionDir,
          avatarPath,
          avatarUrl: avatarInfo(avatarPath).url,
          imageRoots,
          coreLabel: effectiveCoreLabel(),
          pollMs,
        });
        return;
      }
      if (path === `${ROUTE}/image`) {
        const requested = url.searchParams.get('path');
        if (!requested) { sendJson(res, 400, { ok: false, error: 'missing path' }); return; }
        const abs = resolve(requested);
        const roots = imageRoots;
        if (!insideRoots(abs, roots)) { sendJson(res, 403, { ok: false, error: 'path not allowed' }); return; }
        let st;
        try { st = statSync(abs); } catch { sendJson(res, 404, { ok: false, error: 'not found' }); return; }
        if (!st.isFile() || st.size > 8 * 1024 * 1024) { sendJson(res, 413, { ok: false, error: 'file too large' }); return; }
        const type = IMAGE_TYPES[extname(abs).toLowerCase()];
        if (!type) { sendJson(res, 415, { ok: false, error: 'unsupported image type' }); return; }
        try {
          const data = readFileSync(abs);
          res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': data.length,
            'Cache-Control': 'private, max-age=60',
            ...IMAGE_SECURITY_HEADERS,
          });
          res.end(data);
        } catch {
          sendJson(res, 500, { ok: false, error: 'read failed' });
        }
        return;
      }
      if (path === ROUTE || path === `${ROUTE}/` || path === `${ROUTE}/view`) {
        try {
          sendHtml(res, readFileSync(VIEW_PATH, 'utf8'));
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
        return;
      }
      sendJson(res, 404, { ok: false, error: 'not found' });
    },
  }), 'memory-nebula: routes');

  ctx.effect(() => {
    last = refresh();
    startPolling();
    return () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      for (const client of clients) {
        clearInterval(client.timer);
        try { client.res.end(); } catch { /* already closed */ }
      }
      clients.clear();
    };
  }, 'memory-nebula: vault poll');
}
