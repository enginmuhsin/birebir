/** Supabase erişim katmanı: tüm veri işlemleri burada; arayüz kodu doğrudan Supabase çağırmaz. */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface AppConfig {
  supabaseUrl: string;
  supabaseKey: string;          // publishable (anon) anahtar; tarayıcıda kullanılmak içindir
  iceServers: RTCIceServer[];
  /** Yalnız yerel test: Realtime yerine bu WebSocket sinyal sunucusu kullanılır. */
  testSignalUrl?: string;
}

export const cfg: AppConfig = (window as any).BIREBIR_CONFIG;
export const sb: SupabaseClient = createClient(cfg.supabaseUrl, cfg.supabaseKey, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: 'birebir-oturum' },
});

const KOVA = 'bl-ders';

function hata(e: { message?: string } | null): never | void {
  if (e) throw new Error(e.message || 'Bilinmeyen hata');
}

export interface Ben { rol: 'ogretmen' | 'ogrenci' | null; ad?: string; student_id?: string }
export interface Ogrenci { id: string; name: string }
export interface Erisim { student_id: string; durum: 'aktif' | 'iptal'; olusturma: string; son_giris: string | null; kilitli: boolean }
export interface Ders {
  id: string; teacher_id: string; student_id: string; baslangic: string; sure_dk: number;
  durum: 'planli' | 'suruyor' | 'bitti' | 'iptal'; kayit_onay: 'sorulmadi' | 'verildi' | 'reddedildi'; plan: Record<string, unknown>;
}

export async function ben(): Promise<Ben> {
  const { data: s } = await sb.auth.getSession();
  if (!s.session) return { rol: null };
  const { data, error } = await sb.rpc('bl_ben');
  hata(error);
  return data as Ben;
}

export async function ogretmenGiris(email: string, sifre: string) {
  const { error } = await sb.auth.signInWithPassword({ email, password: sifre });
  hata(error);
}
export async function cikis() { await sb.auth.signOut(); }

export async function ogrenciGiris(token: string, pin: string): Promise<void> {
  const r = await fetch(`${cfg.supabaseUrl}/functions/v1/bl-ogrenci-giris`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: cfg.supabaseKey },
    body: JSON.stringify({ token, pin }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    let m = j.hata || 'Giriş yapılamadı';
    if (j.bekle_dk) m += ` (${j.bekle_dk} dk)`;
    else if (typeof j.kalan === 'number') m += ` · kalan deneme: ${j.kalan}`;
    throw new Error(m);
  }
  const { error } = await sb.auth.setSession({ access_token: j.access_token, refresh_token: j.refresh_token });
  hata(error);
}

// ---------- öğretmen ----------
export async function ogrenciler(): Promise<Ogrenci[]> {
  const { data, error } = await sb.from('teshis_students').select('id, name').order('created_at');
  hata(error); return data ?? [];
}
export async function ogrenciEkle(ad: string): Promise<Ogrenci> {
  const { data, error } = await sb.from('teshis_students').insert({ name: ad }).select('id, name').single();
  hata(error); return data as Ogrenci;
}
export async function erisimler(): Promise<Erisim[]> {
  const { data, error } = await sb.rpc('bl_erisim_durumlari');
  hata(error); return (data ?? []) as Erisim[];
}
export async function linkOlustur(studentId: string): Promise<{ token: string; pin: string }> {
  const { data, error } = await sb.rpc('bl_ogrenci_linki_olustur', { p_student: studentId });
  hata(error); return data as { token: string; pin: string };
}
export async function linkIptal(studentId: string) {
  const { error } = await sb.rpc('bl_ogrenci_linki_iptal', { p_student: studentId });
  hata(error);
}
export async function dersler(): Promise<Ders[]> {
  const { data, error } = await sb.from('bl_dersler').select('*').order('baslangic');
  hata(error); return (data ?? []) as Ders[];
}
export async function ders(id: string): Promise<Ders | null> {
  const { data, error } = await sb.from('bl_dersler').select('*').eq('id', id).maybeSingle();
  hata(error); return data as Ders | null;
}
export async function dersEkle(v: { student_id: string; baslangic: string; sure_dk: number }): Promise<Ders> {
  const { data, error } = await sb.from('bl_dersler').insert(v).select('*').single();
  hata(error); return data as Ders;
}
export async function dersGuncelle(id: string, v: Partial<Pick<Ders, 'durum' | 'kayit_onay' | 'baslangic' | 'sure_dk'>>) {
  const { error } = await sb.from('bl_dersler').update(v).eq('id', id);
  hata(error);
}

// ---------- öğrenci ----------
export async function kayitOnayi(dersId: string, onay: boolean) {
  const { error } = await sb.rpc('bl_kayit_onayi', { p_ders: dersId, p_onay: onay });
  hata(error);
}

// ---------- dosyalar (özel kova, yol = <ders_id>/...) ----------
export async function dosyaYukle(yol: string, veri: ArrayBuffer, tur: string) {
  const { error } = await sb.storage.from(KOVA).upload(yol, veri, { contentType: tur, upsert: true });
  hata(error);
}
export async function dosyaIndir(yol: string): Promise<ArrayBuffer | null> {
  const { data, error } = await sb.storage.from(KOVA).download(yol);
  if (error) {
    const st = (error as any).statusCode ?? (error as any).status;
    if (String(st) === '400' || String(st) === '404' || /not.?found/i.test(error.message)) return null;
    throw error;
  }
  return data ? await data.arrayBuffer() : null;
}
export async function imzaliAdres(yol: string, sn = 3600): Promise<string> {
  const { data, error } = await sb.storage.from(KOVA).createSignedUrl(yol, sn);
  hata(error); return data!.signedUrl;
}

export async function gzip(json: unknown): Promise<ArrayBuffer> {
  const s = new Blob([JSON.stringify(json)]).stream().pipeThrough(new CompressionStream('gzip'));
  return await new Response(s).arrayBuffer();
}
export async function gunzip<T>(ab: ArrayBuffer): Promise<T> {
  const s = new Blob([ab]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(s).text());
}
