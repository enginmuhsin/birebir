/**
 * PDF → sayfa görselleri. pdf.js yalnız öğretmen PDF yüklediğinde, gerektiğinde yüklenir (ilk açılış hafif kalır).
 * Her sayfa 1600 px genişlikte PNG'ye çevrilir ve upload ile sunucuya (üretimde Supabase Storage özel kova) gönderilir.
 */
const PDFJS = '/dist/pdfjs/pdf.min.mjs';
const WORKER = '/dist/pdfjs/pdf.worker.min.mjs';
const TARGET_W = 1600;
const MAX_PAGES = 40;

export async function pdfToPages(file: File, upload: (png: Blob, index: number) => Promise<string>): Promise<string[]> {
  const url = PDFJS;
  const pdfjs: any = await import(/* @vite-ignore */ url);
  pdfjs.GlobalWorkerOptions.workerSrc = WORKER;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const n = Math.min(doc.numPages, MAX_PAGES);
  const urls: string[] = [];
  for (let i = 1; i <= n; i++) {
    const pg = await doc.getPage(i);
    const v1 = pg.getViewport({ scale: 1 });
    const vp = pg.getViewport({ scale: TARGET_W / v1.width });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await pg.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
    const blob: Blob = await new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('png'))), 'image/png'));
    urls.push(await upload(blob, i));
  }
  return urls;
}
