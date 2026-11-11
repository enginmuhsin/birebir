/**
 * Prototip girişi: yerel sahte yayın sunucusuyla tahta.
 * URL: ?author=T|S|V&lesson=L-1  [&net=bc] [&media=0] [&nocache=1] [&t0=...]
 */
import { runBoard } from '../../src/board/board.js';
import { LocalWsTransport } from '../../src/board/transport.js';
import type { Author } from '../../src/protocol/index.js';

const qs = new URLSearchParams(location.search);
const lesson = qs.get('lesson') ?? 'L-proto';
runBoard(document.getElementById('app')!, {
  role: (qs.get('author') ?? 'T') as Author | 'V',
  lesson,
  t0: Number(qs.get('t0') ?? Date.now()),
  signal: new LocalWsTransport(`ws://${location.host}`, `lesson:${lesson}`),
  media: qs.get('media') !== '0',
  net: qs.get('net') === 'bc' ? 'bc' : 'auto',
  nocache: qs.get('nocache') === '1',
  batchMs: Number(qs.get('batch') ?? 50),
});
