# Birebir Ders Platformu

Birebir matematik dersi: ortak tahta, görüntülü/sesli görüşme, ders planlama, öğrenci defteri.
YKS Teşhis Defteri ile aynı Supabase projesini kullanır. Canlı adres: https://ders.muhsinengin.com

## Klasörler

| Klasör | İçerik |
| --- | --- |
| `app/` | Yayınlanan site: `index.html`, `config.js` (Supabase adresi + publishable anahtar), `dist/` (derleme çıktısı) |
| `src/app/` | Uygulama: öğretmen paneli, öğrenci girişi ve defteri, ders odası |
| `src/board/` | Ortak tahta: çizim katmanları, araçlar, WebRTC (ses, görüntü, tahta veri kanalı), PDF |
| `src/protocol/` | Çizgi protokolü v1 (YKS Teşhis `stroke_recordings` ile ortak) + JSON Schema |
| `db/` | `000_on_kontrol.sql`, `001_birebir.sql` (canlıda, 30.10.2026), `001_birebir_geri.sql`, `002_dogrulama.sql`, `003_olcum.sql` (Ders Ölçümü + özel şekil kovası `bl-sekiller`, henüz canlıda değil), `003_olcum_geri.sql`, `004_olcum_dogrulama.sql` |
| `supabase/functions/bl-ogrenci-giris/` | Öğrenci girişi Edge Function'ı (`tek-dosya.ts` panele yapıştırmak için) |
| `proto/` | Yerel prototip ve ölçümler (Aşama 0–1) |
| `test/` | Birim testleri, uygulama uçtan uca testi, ekran görüntüleri |

## Komutlar

```
npm ci
npm run build:app     # app/dist üretir (Cloudflare Pages derleme komutu)
npm test              # birim testleri (protokol + giriş mantığı)
npm run test:db       # 65 RLS/RPC + 76 ölçüm testi (yerel PostgreSQL 16 gerekir)
npm run test:app      # uygulama uçtan uca: yerel PostgreSQL + PostgREST + migration (25 kontrol)
npm run e2e           # tahta prototipi uçtan uca (21 kontrol)
```

## Güvenlik notları

- `config.js` yalnız publishable anahtarı içerir. `service_role` / secret anahtar hiçbir dosyada yoktur; Edge Function onu Supabase ortamından okur.
- Öğrenci giriş linkindeki token adres çubuğundan hemen silinir; veritabanında yalnız SHA-256 özeti tutulur.
