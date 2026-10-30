/** Tahta arayüzünün işaretlemesi ve stili (prototip ve uygulama ortak). */
export const BOARD_CSS = `
  :root { color-scheme: light; font-family: system-ui, sans-serif; --line: #e5e7eb; --ink: #111827; --muted: #6b7280; --accent: #2563eb; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f3f4f6; color: var(--ink); }
  header { position: sticky; top: 0; z-index: 5; background: #fff; border-bottom: 1px solid var(--line); }
  .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 12px; font-size: 14px; }
  .pill { padding: 2px 8px; border-radius: 999px; background: #fde68a; font-size: 12px; }
  #status[data-s="bagli"], #rtc[data-s="connected"], #rtc[data-s="veri kanalı açık"] { background: #bbf7d0; }
  #status[data-s="kopuk"], #rtc[data-s="failed"], #rtc[data-s="disconnected"] { background: #fecaca; }
  button { font: inherit; font-size: 13px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; background: #fff; cursor: pointer; min-height: 36px; }
  button[aria-pressed="true"] { border-color: var(--accent); background: #eff6ff; color: #1e40af; }
  button:disabled { opacity: .4; cursor: not-allowed; }
  .sw { width: 28px; min-height: 28px; padding: 0; border-radius: 50%; }
  .sep { width: 1px; height: 24px; background: var(--line); margin: 0 4px; }
  #notice { color: var(--muted); font-size: 12px; }
  #locked { color: #b45309; font-size: 13px; }
  .stack { position: relative; }
  .stack canvas { position: absolute; left: 0; top: 0; display: block; }
  #ink { touch-action: none; }
  #videos { position: fixed; right: 12px; bottom: 12px; display: flex; gap: 8px; z-index: 6; }
  video { width: 160px; height: 90px; background: #111; border-radius: 8px; object-fit: cover; }
  #local { width: 96px; height: 54px; align-self: flex-end; }
  @media (max-width: 500px) {
    video { width: 112px; height: 63px; } #local { width: 64px; height: 36px; }
    #toolbar { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
    #toolbar > * { flex: 0 0 auto; }
  }
`;

export const BOARD_HTML = `<header>
  <div class="row">
    <strong id="who"></strong>
    <span class="pill" id="status">bağlanıyor</span>
    <span class="pill" id="rtc">görüşme bekleniyor</span>
    <span id="notice"></span>
    <span id="locked" hidden>Öğretmen kalemini kapattı; lazerle gösterebilirsin.</span>
  </div>
  <div class="row" id="toolbar" role="toolbar" aria-label="Tahta araçları">
    <button data-tool="kalem">Kalem</button>
    <button data-tool="vurgu">Vurgu</button>
    <button data-tool="cizgi">Düz çizgi</button>
    <button data-tool="cember">Çember</button>
    <button data-tool="silgi">Silgi</button>
    <button data-tool="silgi_alan">Alan silgisi</button>
    <button data-tool="lazer">Lazer</button>
    <span class="sep"></span>
    <button class="sw" data-color="#1f2937" aria-label="Siyah" style="background:#1f2937"></button>
    <button class="sw" data-color="#1d4ed8" aria-label="Mavi" style="background:#1d4ed8"></button>
    <button class="sw" data-color="#dc2626" aria-label="Kırmızı" style="background:#dc2626"></button>
    <button class="sw" data-color="#16a34a" aria-label="Yeşil" style="background:#16a34a"></button>
    <span class="sep"></span>
    <button id="undo" aria-label="Geri al">↶</button>
    <button id="redo" aria-label="İleri al">↷</button>
    <span class="sep"></span>
    <button id="prev" class="t-only" aria-label="Önceki sayfa">‹</button>
    <span id="pageno">1 / 1</span>
    <button id="next" class="t-only" aria-label="Sonraki sayfa">›</button>
    <button id="add" class="t-only">Sayfa ekle</button>
    <button id="pdfbtn" class="t-only">PDF ekle</button>
    <input id="pdf" type="file" accept="application/pdf" hidden>
    <button id="pen" class="t-only"></button>
    <button id="leave">Dersten çık</button>
  </div>
</header>
<main><div class="stack" id="wrap"><canvas id="bg"></canvas><canvas id="ink"></canvas></div></main>
<div id="videos"><video id="remote" autoplay playsinline></video><video id="local" autoplay playsinline muted></video></div>`;

let injected = false;
export function injectStyle() {
  if (injected) return;
  injected = true;
  const st = document.createElement('style');
  st.textContent = BOARD_CSS;
  document.head.appendChild(st);
  // tuval yığınının yüksekliği mürekkep tuvalini izler (tuvaller mutlak konumlu)
  new MutationObserver(() => {
    const c = document.getElementById('ink'), w = document.getElementById('wrap');
    if (c && w && w.style.height !== c.style.height) w.style.height = c.style.height;
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style'] });
}
