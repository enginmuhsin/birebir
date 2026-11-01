// TEK DOSYA SÜRÜMÜ: Supabase panelindeki düzenleyiciye olduğu gibi yapıştırmak için (giris.ts + index.ts birleşik).
// Kaynak: supabase/functions/bl-ogrenci-giris/{giris.ts,index.ts}. Bu dosyayı elle düzenleme; ikisinden üretilir.
// Supabase Edge Function (Deno). Dağıtım: JWT doğrulaması KAPALI (öğrenci henüz oturumsuz çağırır).
// Gizli anahtar yalnız sunucu ortamında okunur; istemciye asla gönderilmez.
import { createClient } from 'npm:@supabase/supabase-js@2';

/**
 * Öğrenci girişi: defter linkindeki token + 6 haneli PIN → Supabase oturumu.
 * Öğrencinin e-postası yoktur; ilk girişte e-postasız bir "sistem hesabı" açılır
 * (adres biçimi s-<öğrenci-id>@ogrenci.ders.muhsinengin.com; bu adrese hiçbir e-posta gönderilmez).
 * Hesabın app_metadata.rol = 'ogrenci' alanı JWT'ye girer; RLS öğrenci yetkisini buradan tanır.
 * Her girişte hesaba yeni rastgele şifre atanır ve sunucuda oturum açılıp jetonlar istemciye verilir;
 * şifre hiçbir yerde saklanmaz ve kimseye gösterilmez.
 */
interface Deps {
  dogrula(token: string, pin: string): Promise<any>;
  hesapBagla(studentId: string, authUserId: string): Promise<void>;
  hesapOlustur(email: string, password: string, studentId: string): Promise<string>;
  hesapGuncelle(authUserId: string, password: string, studentId: string): Promise<void>;
  oturumAc(email: string, password: string): Promise<{ access_token: string; refresh_token: string; expires_at?: number }>;
  rastgele(): string;
}

interface Sonuc { status: number; body: Record<string, unknown> }

const IZINLI_KOKENLER = ['https://ders.muhsinengin.com', 'https://birebir.pages.dev', 'http://localhost:8787', 'http://localhost:5173'];

async function girisYap(deps: Deps, govde: unknown): Promise<Sonuc> {
  const g = (govde ?? {}) as { token?: unknown; pin?: unknown };
  const token = typeof g.token === 'string' ? g.token.trim() : '';
  const pin = typeof g.pin === 'string' ? g.pin.trim() : '';
  if (!token || token.length > 100 || !/^[0-9]{6}$/.test(pin)) return { status: 400, body: { hata: 'Geçersiz link ya da PIN' } };

  const v = await deps.dogrula(token, pin);
  if (!v?.ok) {
    const body: Record<string, unknown> = { hata: v?.hata ?? 'Geçersiz link ya da PIN' };
    if (v?.bekle_dk) body.bekle_dk = v.bekle_dk;
    if (typeof v?.kalan === 'number') body.kalan = v.kalan;
    return { status: v?.bekle_dk ? 429 : 401, body };
  }

  const studentId: string = v.student_id;
  const email = `s-${studentId}@ogrenci.ders.muhsinengin.com`;
  const password = deps.rastgele();
  if (v.auth_user_id) {
    await deps.hesapGuncelle(v.auth_user_id, password, studentId);
  } else {
    const uid = await deps.hesapOlustur(email, password, studentId);
    await deps.hesapBagla(studentId, uid);
  }
  const s = await deps.oturumAc(email, password);
  return { status: 200, body: { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, ad: v.ad ?? null } };
}


const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVIS = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY')!;
const ACIK = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY')!;
const opts = { auth: { persistSession: false, autoRefreshToken: false } };

function rastgele(): string {
  const b = new Uint8Array(32); crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const deps: Deps = {
  async dogrula(token, pin) {
    const admin = createClient(URL_, SERVIS, opts);
    const { data, error } = await admin.rpc('bl_ogrenci_dogrula', { p_token: token, p_pin: pin });
    if (error) throw error;
    return data;
  },
  async hesapBagla(studentId, authUserId) {
    const admin = createClient(URL_, SERVIS, opts);
    const { error } = await admin.rpc('bl_ogrenci_hesap_bagla', { p_student: studentId, p_auth_user: authUserId });
    if (error) throw error;
  },
  async hesapOlustur(email, password, studentId) {
    const admin = createClient(URL_, SERVIS, opts);
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, app_metadata: { rol: 'ogrenci', student_id: studentId },
    });
    if (error) throw error;
    return data.user.id;
  },
  async hesapGuncelle(authUserId, password, studentId) {
    const admin = createClient(URL_, SERVIS, opts);
    const { error } = await admin.auth.admin.updateUserById(authUserId, { password, app_metadata: { rol: 'ogrenci', student_id: studentId } });
    if (error) throw error;
  },
  async oturumAc(email, password) {
    const acik = createClient(URL_, ACIK, opts);
    const { data, error } = await acik.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw error ?? new Error('oturum açılamadı');
    return data.session;
  },
  rastgele,
};

Deno.serve(async req => {
  const origin = req.headers.get('origin') ?? '';
  const cors: Record<string, string> = {
    'Access-Control-Allow-Origin': IZINLI_KOKENLER.includes(origin) ? origin : IZINLI_KOKENLER[0],
    'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return new Response('yalnız POST', { status: 405, headers: cors });
  if (!IZINLI_KOKENLER.includes(origin)) return new Response(JSON.stringify({ hata: 'İzinsiz kaynak' }), { status: 403, headers: { ...cors, 'content-type': 'application/json' } });
  try {
    const r = await girisYap(deps, await req.json().catch(() => null));
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...cors, 'content-type': 'application/json' } });
  } catch (e) {
    console.error('bl-ogrenci-giris', e instanceof Error ? e.message : e);
    return new Response(JSON.stringify({ hata: 'Giriş şu an yapılamıyor, biraz sonra tekrar deneyin' }), { status: 500, headers: { ...cors, 'content-type': 'application/json' } });
  }
});
