/**
 * Birebir ders uygulaması (ders.muhsinengin.com).
 * Rotalar: #/            → giriş / öğretmen paneli / öğrenci defteri
 *          #/o/<token>   → öğrenci PIN girişi (token adres çubuğundan hemen silinir)
 *          #/ders/<id>   → ders odası (tahta + görüşme)
 */
import * as api from './api.js';
import { runBoard } from '../board/board.js';
import { LocalWsTransport, SupabaseTransport } from '../board/transport.js';
import type { Packet } from '../protocol/index.js';

const app = document.getElementById('app')!;
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (iso: string) => new Date(iso).toLocaleString('tr-TR', { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const DURUM: Record<string, string> = { planli: 'Planlı', suruyor: 'Sürüyor', bitti: 'Bitti', iptal: 'İptal' };

function view(html: string) { app.innerHTML = html; }
function msg(el: HTMLElement | null, text: string, kind: 'hata' | 'tamam' = 'hata') {
  if (!el) return; el.textContent = text; el.dataset.kind = kind;
}
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => app.querySelector(sel) as T;

/** Ders odasına girilebilir mi: sürüyorsa ya da başlangıcına 30 dk'dan az kaldıysa (bitiş + 30 dk'ya kadar). */
function girilebilir(d: api.Ders) {
  if (d.durum === 'suruyor') return true;
  if (d.durum !== 'planli') return false;
  const t = Date.parse(d.baslangic), now = Date.now();
  return now > t - 30 * 60000 && now < t + (d.sure_dk + 30) * 60000;
}

// ---------------- yönlendirme ----------------
async function route() {
  const h = location.hash;
  const mO = h.match(/^#\/o\/([A-Za-z0-9_-]{20,100})$/);
  if (mO) {
    // token hafızaya alınır, adres çubuğundan ve geçmişten silinir
    sessionStorage.setItem('birebir-token', mO[1]);
    history.replaceState(null, '', location.pathname + '#/giris');
    return pinSayfasi();
  }
  if (h === '#/giris' && sessionStorage.getItem('birebir-token')) return pinSayfasi();
  const b = await api.ben().catch(() => ({ rol: null } as api.Ben));
  const mD = h.match(/^#\/ders\/([0-9a-f-]{36})$/);
  if (mD && b.rol) return dersOdasi(mD[1], b);
  if (b.rol === 'ogretmen') return ogretmenPaneli(b);
  if (b.rol === 'ogrenci') return ogrenciDefteri(b);
  return girisSayfasi(b);
}
window.addEventListener('hashchange', () => { if (!location.hash.startsWith('#/ders/') || !app.querySelector('#ink')) location.reload(); });

// ---------------- öğretmen girişi ----------------
async function girisSayfasi(b: api.Ben) {
  const { data } = await api.sb.auth.getSession();
  const yanlisHesap = data.session && b.rol === null;
  view(`<main class="kart dar">
    <p class="ust">Birebir Ders</p>
    <h1>Öğretmen girişi</h1>
    <p class="aciklama">Teşhis Defteri'ndeki e-posta ve şifrenle giriş yap. <strong>Öğrenciysen</strong> öğretmeninin gönderdiği linki aç; giriş yapman gerekmez.</p>
    ${yanlisHesap ? `<p class="uyari">Bu hesap birebir öğretmeni olarak tanımlı değil. Yöneticiye başvur.</p>` : ''}
    <form id="f" class="form">
      <label>E-posta<input name="e" type="email" autocomplete="username" required></label>
      <label>Şifre<input name="s" type="password" autocomplete="current-password" required></label>
      <button class="ana" type="submit">Giriş yap</button>
      <p class="mesaj" id="m" role="alert"></p>
    </form></main>`);
  $<HTMLFormElement>('#f').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target as HTMLFormElement);
    try { await api.ogretmenGiris(String(f.get('e')), String(f.get('s'))); await route(); }
    catch (e: any) { msg($('#m'), e.message === 'Invalid login credentials' ? 'E-posta ya da şifre hatalı' : e.message); }
  });
}

// ---------------- öğrenci PIN girişi ----------------
function pinSayfasi() {
  view(`<main class="kart dar">
    <p class="ust">Birebir Ders</p>
    <h1>Derse giriş</h1>
    <p class="aciklama">Öğretmeninin sana verdiği 6 haneli PIN'i yaz. Bu cihazda bir kez yapman yeterli.</p>
    <form id="f" class="form">
      <label>PIN<input name="pin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required class="pin"></label>
      <button class="ana" type="submit">Giriş</button>
      <p class="mesaj" id="m" role="alert"></p>
    </form></main>`);
  $<HTMLInputElement>('input[name=pin]').focus();
  $<HTMLFormElement>('#f').addEventListener('submit', async ev => {
    ev.preventDefault();
    const pin = String(new FormData(ev.target as HTMLFormElement).get('pin')).trim();
    const token = sessionStorage.getItem('birebir-token') || '';
    try {
      await api.ogrenciGiris(token, pin);
      sessionStorage.removeItem('birebir-token');
      history.replaceState(null, '', location.pathname + '#/');
      await route();
    } catch (e: any) { msg($('#m'), e.message); }
  });
}

// ---------------- öğretmen paneli ----------------
async function ogretmenPaneli(b: api.Ben) {
  view(`<header class="bar"><strong>Birebir Ders</strong><span>${esc(b.ad)}</span><button id="cik" class="ince">Çıkış</button></header>
  <main class="panel">
    <section class="kart"><h2>Dersler</h2><div id="dersler">Yükleniyor…</div>
      <form id="fd" class="satir">
        <label>Öğrenci<select name="s" required></select></label>
        <label>Başlangıç<input name="t" type="datetime-local" required></label>
        <label>Süre<select name="d"><option>30</option><option>45</option><option selected>60</option><option>90</option></select></label>
        <button class="ana" type="submit">Ders planla</button>
      </form><p class="mesaj" id="md" role="alert"></p></section>
    <section class="kart"><h2>Öğrenciler</h2>
      <p class="aciklama">Liste Teşhis Defteri ile ortaktır. Öğrenciye defter linki ve PIN üret; ikisini ayrı kanallardan ilet.</p>
      <div id="ogr">Yükleniyor…</div>
      <form id="fo" class="satir"><label>Takma ad<input name="a" maxlength="80" required placeholder="ör. Ali K."></label><button type="submit">Öğrenci ekle</button></form>
      <p class="mesaj" id="mo" role="alert"></p></section>
    <dialog id="linkdlg"></dialog>
  </main>`);
  $('#cik').onclick = async () => { await api.cikis(); location.hash = '#/'; location.reload(); };
  const now = new Date(Date.now() + 10 * 60000); now.setSeconds(0, 0);
  $<HTMLInputElement>('input[name=t]').value = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

  let ogr: api.Ogrenci[] = [];
  async function yukle() {
    const [o, e, d] = await Promise.all([api.ogrenciler(), api.erisimler(), api.dersler()]);
    ogr = o;
    const adi = (id: string) => o.find(x => x.id === id)?.name ?? '—';
    $<HTMLSelectElement>('select[name=s]').innerHTML = o.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
    const gun = d.filter(x => x.durum !== 'iptal' && (x.durum !== 'bitti' || Date.parse(x.baslangic) > Date.now() - 7 * 864e5));
    $('#dersler').innerHTML = gun.length ? `<table><thead><tr><th>Zaman</th><th>Öğrenci</th><th>Süre</th><th>Durum</th><th></th></tr></thead><tbody>${gun.map(x => `
      <tr data-id="${x.id}"><td>${esc(fmt(x.baslangic))}</td><td>${esc(adi(x.student_id))}</td><td>${x.sure_dk} dk</td><td><span class="etiket ${x.durum}">${DURUM[x.durum]}</span></td>
      <td class="sag">${x.durum === 'bitti' ? '' : `<a class="dugme ana" href="#/ders/${x.id}">Derse gir</a> <button class="ince" data-iptal="${x.id}">İptal</button>`}</td></tr>`).join('')}</tbody></table>`
      : '<p class="bos">Planlı ders yok.</p>';
    $('#ogr').innerHTML = o.length ? `<table><thead><tr><th>Öğrenci</th><th>Defter erişimi</th><th></th></tr></thead><tbody>${o.map(x => {
      const er = e.find(z => z.student_id === x.id);
      const durum = !er ? 'Link yok' : er.durum === 'iptal' ? 'İptal edildi' : er.kilitli ? 'Kilitli (hatalı PIN)' : er.son_giris ? `Aktif · son giriş ${fmt(er.son_giris)}` : 'Link verildi, henüz girmedi';
      return `<tr data-id="${x.id}"><td>${esc(x.name)}</td><td>${esc(durum)}</td><td class="sag">
        <button data-link="${x.id}">${er && er.durum === 'aktif' ? 'Linki yenile' : 'Link oluştur'}</button>
        ${er && er.durum === 'aktif' ? `<button class="ince" data-kes="${x.id}">Erişimi kapat</button>` : ''}</td></tr>`;
    }).join('')}</tbody></table>` : '<p class="bos">Henüz öğrenci yok.</p>';
  }
  await yukle().catch(e => msg($('#md'), e.message));

  app.addEventListener('click', async ev => {
    const t = ev.target as HTMLElement;
    try {
      if (t.dataset.iptal) { if (confirm('Ders iptal edilsin mi?')) { await api.dersGuncelle(t.dataset.iptal, { durum: 'iptal' }); await yukle(); } }
      else if (t.dataset.kes) { if (confirm('Öğrencinin defter erişimi hemen kapansın mı?')) { await api.linkIptal(t.dataset.kes); await yukle(); } }
      else if (t.dataset.link) {
        const r = await api.linkOlustur(t.dataset.link);
        const url = `${location.origin}${location.pathname}#/o/${r.token}`;
        const dlg = $<HTMLDialogElement>('#linkdlg');
        dlg.innerHTML = `<h2>${esc(ogr.find(x => x.id === t.dataset.link)?.name)} için defter linki</h2>
          <p class="aciklama">Bu bilgiler yalnız şimdi görünür. Linki ve PIN'i <strong>ayrı kanallardan</strong> gönder (ör. link mesajla, PIN telefonda). Eski link artık çalışmaz.</p>
          <label>Link<input readonly value="${esc(url)}" id="lurl"></label>
          <label>PIN<input readonly value="${r.pin}" id="lpin" class="pin"></label>
          <div class="satir"><button data-kopya="lurl">Linki kopyala</button><button data-kopya="lpin">PIN'i kopyala</button><button class="ana" id="kapat">Tamam</button></div>`;
        dlg.showModal();
        dlg.querySelector<HTMLButtonElement>('#kapat')!.onclick = () => { dlg.close(); void yukle(); };
      } else if (t.dataset.kopya) {
        const v = (app.querySelector('#' + t.dataset.kopya) as HTMLInputElement).value;
        await navigator.clipboard.writeText(v).catch(() => {});
        t.textContent = 'Kopyalandı';
      }
    } catch (e: any) { msg($('#mo'), e.message); }
  });
  $<HTMLFormElement>('#fd').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = new FormData(ev.target as HTMLFormElement);
    try {
      await api.dersEkle({ student_id: String(f.get('s')), baslangic: new Date(String(f.get('t'))).toISOString(), sure_dk: Number(f.get('d')) });
      msg($('#md'), 'Ders planlandı', 'tamam'); await yukle();
    } catch (e: any) { msg($('#md'), e.message); }
  });
  $<HTMLFormElement>('#fo').addEventListener('submit', async ev => {
    ev.preventDefault();
    const fe = ev.target as HTMLFormElement;
    try { await api.ogrenciEkle(String(new FormData(fe).get('a')).trim()); fe.reset(); msg($('#mo'), 'Öğrenci eklendi', 'tamam'); await yukle(); }
    catch (e: any) { msg($('#mo'), e.message); }
  });
}

// ---------------- öğrenci defteri ----------------
async function ogrenciDefteri(b: api.Ben) {
  view(`<header class="bar"><strong>Birebir Ders</strong><span>${esc(b.ad)}</span><button id="cik" class="ince">Çıkış</button></header>
    <main class="panel"><section class="kart"><h2>Derslerim</h2><div id="dersler">Yükleniyor…</div></section></main>`);
  $('#cik').onclick = async () => { if (confirm('Bu cihazdan çıkılsın mı? Tekrar girmek için link ve PIN gerekir.')) { await api.cikis(); location.reload(); } };
  const ciz = async () => {
    const d = (await api.dersler()).filter(x => x.durum !== 'iptal');
    const yakin = d.filter(x => x.durum !== 'bitti'), gecmis = d.filter(x => x.durum === 'bitti').reverse();
    $('#dersler').innerHTML = (yakin.length ? `<ul class="liste">${yakin.map(x => `<li><span>${esc(fmt(x.baslangic))} · ${x.sure_dk} dk</span>
        ${girilebilir(x) ? `<a class="dugme ana" href="#/ders/${x.id}">Derse gir</a>` : '<span class="etiket planli">Zamanı gelince açılır</span>'}</li>`).join('')}</ul>`
      : '<p class="bos">Planlı dersin yok.</p>')
      + (gecmis.length ? `<h3>Geçmiş dersler</h3><ul class="liste">${gecmis.map(x => `<li><span>${esc(fmt(x.baslangic))}</span><span class="etiket bitti">Bitti</span></li>`).join('')}</ul>` : '');
  };
  await ciz().catch(e => { $('#dersler').textContent = e.message; });
  setInterval(() => { void ciz(); }, 30000);
}

// ---------------- ders odası ----------------
async function dersOdasi(id: string, b: api.Ben) {
  const d = await api.ders(id).catch(() => null);
  if (!d) { view(`<main class="kart dar"><h1>Ders bulunamadı</h1><p><a href="#/">Geri dön</a></p></main>`); return; }
  const role = b.rol === 'ogretmen' ? 'T' : 'S';
  if (role === 'S' && !girilebilir(d)) { view(`<main class="kart dar"><h1>Ders henüz açılmadı</h1><p>${esc(fmt(d.baslangic))}</p><p><a href="#/">Geri dön</a></p></main>`); return; }
  if (role === 'T' && d.durum === 'planli') await api.dersGuncelle(id, { durum: 'suruyor' });

  view(`<div class="dersbar"><span id="kayit"></span><span id="dersbilgi">${esc(fmt(d.baslangic))} · ${d.sure_dk} dk</span>
    ${role === 'T' ? '<button id="sor" class="ince">Kayıt onayını yeniden sor</button><button id="bitir" class="ince">Dersi bitir</button>' : ''}</div>
    <div id="tahta"></div><dialog id="onay"></dialog>`);

  const { data: s } = await api.sb.auth.getSession();
  const token = s.session?.access_token ?? '';
  const signal = api.cfg.testSignalUrl
    ? new LocalWsTransport(`${api.cfg.testSignalUrl}?token=${encodeURIComponent(token)}`, `ders:${id}`)
    : new SupabaseTransport(api.sb, `ders:${id}`);
  const ayrilis = async () => { await (window as any).__saveBoard?.(); location.hash = '#/'; };

  runBoard($('#tahta'), {
    role, lesson: id, t0: Date.parse(d.baslangic), signal,
    iceServers: api.cfg.iceServers,
    media: !new URLSearchParams(location.search).has('medyasiz'),
    uploadPage: async (png, i) => {
      const yol = `${id}/sayfa-${Date.now()}-${i}.png`;
      await api.dosyaYukle(yol, await png.arrayBuffer(), 'image/png');
      return 'sb:' + yol;
    },
    resolveSrc: async src => (src.startsWith('sb:') ? api.imzaliAdres(src.slice(3)) : src),
    loadLog: async () => {
      const ab = await api.dosyaIndir(`${id}/tahta.json.gz`);
      return ab ? await api.gunzip<Packet[]>(ab) : null;
    },
    saveLog: role === 'T' ? async packets => api.dosyaYukle(`${id}/tahta.json.gz`, await api.gzip(packets), 'application/gzip') : undefined,
    onLeave: () => { void ayrilis(); },
  });

  // kayıt onayı (ses kaydının kendisi Aşama 2'de; burada onay akışı)
  const kayitEl = $('#kayit');
  const ONAY: Record<string, string> = { sorulmadi: 'Kayıt onayı bekleniyor', verildi: 'Kayıt onayı verildi', reddedildi: 'Kayıt yok (onay verilmedi)' };
  let sorulan = false;
  const kontrol = async () => {
    const g = await api.ders(id).catch(() => null);
    if (!g) return;
    kayitEl.textContent = ONAY[g.kayit_onay]; kayitEl.dataset.k = g.kayit_onay;
    if (g.durum === 'bitti' && role === 'S') { kayitEl.textContent = 'Ders bitti'; }
    if (role === 'S' && g.kayit_onay === 'sorulmadi' && !sorulan) {
      sorulan = true;
      const dlg = $<HTMLDialogElement>('#onay');
      dlg.innerHTML = `<h2>Bu dersin sesi kaydedilsin mi?</h2>
        <p class="aciklama">Kayıt, dersi sonra tekrar izleyebilmen içindir. Görüntü kaydedilmez. Yalnız sen ve öğretmenin erişebilir. 18 yaşından küçüksen bu onayı velinle birlikte ver.</p>
        <div class="satir"><button class="ana" data-o="1">Evet, kaydedilsin</button><button data-o="0">Hayır</button></div>`;
      dlg.showModal();
      dlg.onclick = async ev => {
        const o = (ev.target as HTMLElement).dataset.o; if (o === undefined) return;
        dlg.close();
        await api.kayitOnayi(id, o === '1').catch(e => alert(e.message));
        sorulan = false; void kontrol();
      };
    }
  };
  await kontrol();
  setInterval(() => { void kontrol(); }, 10000);
  if (role === 'T') {
    $('#sor').onclick = async () => { await api.dersGuncelle(id, { kayit_onay: 'sorulmadi' }); void kontrol(); };
    $('#bitir').onclick = async () => {
      if (!confirm('Ders bitirilsin mi?')) return;
      await (window as any).__saveBoard?.();
      await api.dersGuncelle(id, { durum: 'bitti' });
      location.hash = '#/';
    };
  }
}

route().catch(e => view(`<main class="kart dar"><h1>Bir sorun oluştu</h1><p>${esc(e.message)}</p></main>`));
