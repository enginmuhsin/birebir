/**
 * Öğrenci girişi: defter linkindeki token + 6 haneli PIN → Supabase oturumu.
 * Öğrencinin e-postası yoktur; ilk girişte e-postasız bir "sistem hesabı" açılır
 * (adres biçimi s-<öğrenci-id>@ogrenci.ders.muhsinengin.com; bu adrese hiçbir e-posta gönderilmez).
 * Hesabın app_metadata.rol = 'ogrenci' alanı JWT'ye girer; RLS öğrenci yetkisini buradan tanır.
 * Her girişte hesaba yeni rastgele şifre atanır ve sunucuda oturum açılıp jetonlar istemciye verilir;
 * şifre hiçbir yerde saklanmaz ve kimseye gösterilmez.
 */
export interface Deps {
  dogrula(token: string, pin: string): Promise<any>;
  hesapBagla(studentId: string, authUserId: string): Promise<void>;
  hesapOlustur(email: string, password: string, studentId: string): Promise<string>;
  hesapGuncelle(authUserId: string, password: string, studentId: string): Promise<void>;
  oturumAc(email: string, password: string): Promise<{ access_token: string; refresh_token: string; expires_at?: number }>;
  rastgele(): string;
}

export interface Sonuc { status: number; body: Record<string, unknown> }

export const IZINLI_KOKENLER = ['https://ders.muhsinengin.com', 'https://birebir.pages.dev', 'http://localhost:8787', 'http://localhost:5173'];

export async function girisYap(deps: Deps, govde: unknown): Promise<Sonuc> {
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
