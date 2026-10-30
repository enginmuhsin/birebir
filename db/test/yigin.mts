/**
 * YALNIZ TEST: yerel "Supabase benzeri" yığın.
 *  - Gerçek PostgreSQL 16 + gerçek migration 001 + gerçek PostgREST (RLS ve RPC'ler gerçekten çalışır)
 *  - Sahte Auth (şifreyle giriş, yenileme jetonu), sahte Storage (yetki kontrolü storage.objects RLS'i ile),
 *  - Edge Function mantığı (girisYap) aynı süreçte,
 *  - Realtime yerine yetkili WebSocket kanal sunucusu (katılımda bl_derse_erisir ile denetler).
 * Gerçek Supabase Realtime / Storage / Auth sunucularının kendisi DEĞİLDİR.
 */
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { createHmac, createHash, randomUUID, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { WebSocketServer, type WebSocket } from 'ws';
import { girisYap } from '../../supabase/functions/bl-ogrenci-giris/giris.js';

const require_ = createRequire(import.meta.url);
const { Client } = require_('pg');

const ROOT = new URL('../../', import.meta.url).pathname;
const PGHOST = '/var/lib/postgresql/bltest', PGPORT = 54329, DB = 'bltest_app';
const PORT = Number(process.env.PORT || 8800), REST = 3010;
const SECRET = 'yerel-test-jwt-sirri-en-az-32-karakter-uzunlukta';
const FILES = '/tmp/claude-0/-home-claude/2cfc59d7-a6f0-5c78-9515-6d5ab28faabe/scratchpad/yigin-dosyalar';
const POSTGREST = '/tmp/claude-0/-home-claude/2cfc59d7-a6f0-5c78-9515-6d5ab28faabe/scratchpad/tools/postgrest';

// ---------- JWT ----------
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
export function jwt(payload: Record<string, unknown>) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  return `${h}.${p}.${createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url')}`;
}
function verify(t: string): any | null {
  const [h, p, s] = (t || '').split('.');
  if (!s || createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url') !== s) return null;
  const c = JSON.parse(Buffer.from(p, 'base64url').toString());
  return c.exp && c.exp * 1000 < Date.now() ? null : c;
}
export const ANON_KEY = jwt({ role: 'anon', iss: 'yerel', exp: 4102444800 });
const SERVICE_KEY = jwt({ role: 'service_role', iss: 'yerel', exp: 4102444800 });

// ---------- veritabanı ----------
const admin = new Client({ host: PGHOST, port: PGPORT, user: 'postgres', database: 'postgres' });
await admin.connect();
await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${DB}'`);
await admin.query(`drop database if exists ${DB}`);
await admin.query(`create database ${DB}`);
await admin.end();
const db = new Client({ host: PGHOST, port: PGPORT, user: 'postgres', database: DB });
await db.connect();
for (const f of ['db/test/supabase_mock.sql', 'db/test/teshis_mevcut.sql', 'db/001_birebir.sql']) await db.query(readFileSync(ROOT + f, 'utf8'));
await db.query(`
  alter table auth.users add column if not exists pw text, add column if not exists app_metadata jsonb not null default '{}';
  create unique index if not exists objects_kova_ad on storage.objects (bucket_id, name);
  do $$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if; end $$;
  grant anon, authenticated, service_role to authenticator;`);
const pwh = (p: string) => createHash('sha256').update(p).digest('hex');

export const T1 = randomUUID(), T2 = randomUUID();
await db.query(`insert into auth.users (id, email, pw) values ($1, 'ogretmen@test.local', $3), ($2, 'baska@test.local', $3)`, [T1, T2, pwh('Deneme-12345')]);
await db.query(`insert into public.bl_ogretmenler (user_id, ad) values ($1, 'Muhsin Engin'), ($2, 'Başka Öğretmen')`, [T1, T2]);
await db.query(`insert into public.teshis_students (teacher_id, name) values ($1, 'Deneme Öğrenci')`, [T1]);

/** Bir kullanıcının yetkisiyle sorgu (RLS uygulanır). */
async function asUser(claims: any, sql: string, params: unknown[] = []) {
  await db.query('begin');
  try {
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await db.query(`set local role ${claims.role === 'service_role' ? 'service_role' : claims.role === 'authenticated' ? 'authenticated' : 'anon'}`);
    const r = await db.query(sql, params);
    await db.query('commit');
    return r;
  } catch (e) { await db.query('rollback'); throw e; }
}

// ---------- PostgREST ----------
const pgrst = spawn(POSTGREST, [], {
  env: {
    PGRST_DB_URI: `postgres://authenticator@/${DB}?host=${PGHOST}&port=${PGPORT}`,
    PGRST_DB_SCHEMAS: 'public', PGRST_DB_ANON_ROLE: 'anon', PGRST_JWT_SECRET: SECRET,
    PGRST_SERVER_PORT: String(REST), PGRST_LOG_LEVEL: 'error',
  }, stdio: ['ignore', 'inherit', 'inherit'],
});
process.on('exit', () => pgrst.kill());
for (let i = 0; i < 50; i++) { try { await fetch(`http://localhost:${REST}/`); break; } catch { await new Promise(r => setTimeout(r, 200)); } }

// ---------- auth ----------
const refresh = new Map<string, string>(); // refresh token -> user id
async function userRow(id: string) { return (await db.query('select id, email, app_metadata from auth.users where id = $1', [id])).rows[0]; }
async function session(id: string) {
  const u = await userRow(id);
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const claims = { sub: u.id, role: 'authenticated', aud: 'authenticated', email: u.email, app_metadata: u.app_metadata, exp };
  const rt = randomBytes(24).toString('hex'); refresh.set(rt, u.id);
  const user = { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, app_metadata: u.app_metadata, user_metadata: {}, created_at: new Date().toISOString() };
  return { access_token: jwt(claims), token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: rt, user };
}
async function passwordLogin(email: string, password: string) {
  const r = await db.query('select id from auth.users where email = $1 and pw = $2', [email, pwh(password)]);
  return r.rows[0] ? session(r.rows[0].id) : null;
}

// ---------- edge function bağımlılıkları (gerçek RPC'ler PostgREST üzerinden service_role ile) ----------
async function rpcService(fn: string, body: unknown) {
  const r = await fetch(`http://localhost:${REST}/rpc/${fn}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_KEY}` }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(JSON.stringify(j));
  return j;
}
const deps = {
  dogrula: (token: string, pin: string) => rpcService('bl_ogrenci_dogrula', { p_token: token, p_pin: pin }),
  hesapBagla: async (s: string, u: string) => { await rpcService('bl_ogrenci_hesap_bagla', { p_student: s, p_auth_user: u }); },
  hesapOlustur: async (email: string, password: string, studentId: string) => {
    const id = randomUUID();
    await db.query('insert into auth.users (id, email, pw, app_metadata) values ($1, $2, $3, $4)', [id, email, pwh(password), { rol: 'ogrenci', student_id: studentId }]);
    return id;
  },
  hesapGuncelle: async (id: string, password: string, studentId: string) => {
    await db.query('update auth.users set pw = $2, app_metadata = $3 where id = $1', [id, pwh(password), { rol: 'ogrenci', student_id: studentId }]);
  },
  oturumAc: async (email: string, password: string) => { const s = await passwordLogin(email, password); if (!s) throw new Error('giriş'); return s; },
  rastgele: () => randomBytes(32).toString('base64url'),
};

// ---------- yardımcılar ----------
const body = (req: IncomingMessage) => new Promise<Buffer>(res => { const c: Buffer[] = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); });
function json(res: ServerResponse, status: number, obj: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(obj));
}
function claimsOf(req: IncomingMessage) {
  const t = (req.headers.authorization || '').replace(/^Bearer /, '');
  return verify(t) ?? { role: 'anon' };
}
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.map': 'application/json' };
mkdirSync(FILES, { recursive: true });
const fileOf = (bucket: string, name: string) => join(FILES, createHash('sha1').update(bucket + '/' + name).digest('hex'));
const signOf = (path: string, exp: number) => createHmac('sha256', SECRET).update(`${path}|${exp}`).digest('base64url');

// ---------- HTTP ----------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, 'http://x');
    const p = url.pathname;
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' }); res.end(); return;
    }
    // REST → PostgREST
    if (p.startsWith('/rest/v1/')) {
      const target = `http://localhost:${REST}${p.slice(8)}${url.search}`;
      const headers = { ...req.headers } as Record<string, any>;
      delete headers.host;
      if (!headers.authorization) headers.authorization = `Bearer ${ANON_KEY}`;
      const preq = httpRequest(target, { method: req.method, headers }, pres => { res.writeHead(pres.statusCode!, { ...pres.headers, 'access-control-allow-origin': '*' }); pres.pipe(res); });
      req.pipe(preq); return;
    }
    // Auth
    if (p === '/auth/v1/token') {
      const b = JSON.parse((await body(req)).toString() || '{}');
      const g = url.searchParams.get('grant_type');
      let s = null;
      if (g === 'password') s = await passwordLogin(b.email, b.password);
      else if (g === 'refresh_token' && refresh.has(b.refresh_token)) s = await session(refresh.get(b.refresh_token)!);
      return s ? json(res, 200, s) : json(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', msg: 'Invalid login credentials', code: 'invalid_credentials' });
    }
    if (p === '/auth/v1/user') { const c = claimsOf(req); return c.sub ? json(res, 200, (await session(c.sub)).user) : json(res, 401, { msg: 'yok' }); }
    if (p === '/auth/v1/logout') { res.writeHead(204, { 'access-control-allow-origin': '*' }); res.end(); return; }
    // Edge Function
    if (p === '/functions/v1/bl-ogrenci-giris') {
      const r = await girisYap(deps, JSON.parse((await body(req)).toString() || 'null'));
      return json(res, r.status, r.body);
    }
    // Storage
    let m = p.match(/^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/);
    if (m && req.method === 'POST') {
      const [, bucket, name] = m.map(decodeURIComponent);
      const ok = (await asUser(claimsOf(req), 'select 1 from storage.objects where bucket_id = $1 and name = $2', [bucket, name])).rowCount;
      if (!ok) return json(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      const exp = Date.now() + 3600e3;
      return json(res, 200, { signedURL: `/object/sign/${bucket}/${name}?token=${signOf(bucket + '/' + name, exp)}&exp=${exp}` });
    }
    if (m && req.method === 'GET') {
      const [, bucket, name] = m.map(decodeURIComponent);
      const exp = Number(url.searchParams.get('exp'));
      if (exp < Date.now() || signOf(bucket + '/' + name, exp) !== url.searchParams.get('token')) return json(res, 400, { statusCode: '403', error: 'imza' });
      res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' }); res.end(readFileSync(fileOf(bucket, name))); return;
    }
    m = p.match(/^\/storage\/v1\/object\/(?:authenticated\/)?([^/]+)\/(.+)$/);
    if (m) {
      const [, bucket, name] = m.map(decodeURIComponent);
      const c = claimsOf(req);
      if (req.method === 'POST' || req.method === 'PUT') {
        const data = await body(req);
        try {
          await asUser(c, `insert into storage.objects (bucket_id, name) values ($1, $2) on conflict (bucket_id, name) do update set owner = excluded.owner`, [bucket, name]);
        } catch (e: any) { return json(res, 400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }); }
        writeFileSync(fileOf(bucket, name), data);
        return json(res, 200, { Key: `${bucket}/${name}`, Id: randomUUID() });
      }
      if (req.method === 'GET') {
        const ok = (await asUser(c, 'select 1 from storage.objects where bucket_id = $1 and name = $2', [bucket, name])).rowCount;
        if (!ok || !existsSync(fileOf(bucket, name))) return json(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' }); res.end(readFileSync(fileOf(bucket, name))); return;
      }
    }
    // Statik uygulama (config.js test ayarlarıyla)
    if (p === '/config.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(`window.BIREBIR_CONFIG = ${JSON.stringify({ supabaseUrl: `http://localhost:${PORT}`, supabaseKey: ANON_KEY, iceServers: [], testSignalUrl: `ws://localhost:${PORT}/ws` })};`);
      return;
    }
    const f = normalize(join(ROOT, 'app', p === '/' ? 'index.html' : p));
    if (!f.startsWith(join(ROOT, 'app')) || !existsSync(f)) { res.writeHead(404); res.end('yok'); return; }
    res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream' }); res.end(readFileSync(f));
  } catch (e: any) { console.error(e); json(res, 500, { hata: e.message }); }
});

// ---------- yetkili kanal sunucusu (Realtime yerine) ----------
const wss = new WebSocketServer({ server, path: '/ws' });
const topics = new Map<string, Set<WebSocket>>();
export const kanalRed: string[] = [];
wss.on('connection', (ws: WebSocket & { topics?: Set<string>; claims?: any }, req) => {
  ws.claims = verify(new URL(req.url!, 'http://x').searchParams.get('token') || '') ?? { role: 'anon' };
  ws.topics = new Set();
  ws.on('message', async raw => {
    let m: any; try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.type === 'join') {
      const id = String(m.topic).replace(/^ders:/, '');
      let ok = false;
      try { ok = !!(await asUser(ws.claims, 'select public.bl_derse_erisir(public.bl_uuid($1)) ok', [id])).rows[0]?.ok; } catch { ok = false; }
      if (!ok) { kanalRed.push(m.topic); ws.send(JSON.stringify({ type: 'error', topic: m.topic, message: 'yetkisiz' })); ws.close(); return; }
      if (!topics.has(m.topic)) topics.set(m.topic, new Set());
      topics.get(m.topic)!.add(ws); ws.topics!.add(m.topic);
      ws.send(JSON.stringify({ type: 'joined', topic: m.topic }));
    } else if (m.type === 'broadcast' && ws.topics!.has(m.topic)) {
      const out = JSON.stringify({ type: 'broadcast', topic: m.topic, event: m.event, payload: m.payload });
      for (const peer of topics.get(m.topic) ?? []) if (peer !== ws && peer.readyState === 1) peer.send(out);
    }
  });
  ws.on('close', () => { for (const t of ws.topics!) topics.get(t)?.delete(ws); });
});

server.listen(PORT, () => console.log(`yığın hazır http://localhost:${PORT}`));
export { db, asUser };
