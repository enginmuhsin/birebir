// Supabase Edge Function (Deno). Dağıtım: JWT doğrulaması KAPALI (öğrenci henüz oturumsuz çağırır).
// Gizli anahtar yalnız sunucu ortamında okunur; istemciye asla gönderilmez.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { girisYap, IZINLI_KOKENLER, type Deps } from './giris.ts';

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
