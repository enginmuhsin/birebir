// Birebir Ders · site ayarları. Supabase "publishable" anahtarı tarayıcıda kullanılmak içindir;
// güvenliği veritabanındaki satır düzeyi güvenlik (RLS) sağlar. "service_role"/"secret" anahtarı ASLA buraya yazılmaz.
window.BIREBIR_CONFIG = {
  supabaseUrl: "https://kfpziysmsajqidkzaawh.supabase.co",
  supabaseKey: "sb_publishable_jzoa489kAPGEComqCF2JSQ_N8gjKPjC",
  // STUN: cihazların kendi açık adresini öğrenmesi için (ücretsiz). TURN (röle) Cloudflare hesabı açılınca eklenecek.
  iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }]
};
