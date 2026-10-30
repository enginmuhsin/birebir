/** Çizgi protokolü v1 için JSON Schema (draft-07). Sunucu tarafı doğrulama ve teşhis kayıtları için. */

const coord = { type: 'number', minimum: -1, maximum: 10 };
const point = {
  type: 'array', minItems: 3, maxItems: 3,
  items: [coord, coord, { type: 'number', minimum: 0, maximum: 1 }],
};
const pts = { type: 'array', items: point, maxItems: 512 };
const ids = { type: 'array', items: { type: 'string', pattern: '^[TS]-[0-9]{1,9}$' }, minItems: 1, maxItems: 1000 };
const strokeId = { type: 'string', pattern: '^[TS]-[0-9]{1,9}$' };

const base = {
  v: { const: 1 },
  lesson: { type: 'string', minLength: 1, maxLength: 64 },
  author: { enum: ['T', 'S'] },
  seq: { type: 'integer', minimum: 1 },
  t: { type: 'integer', minimum: 0 },
  page: { type: 'integer', minimum: 0, maximum: 999 },
};
const baseReq = ['v', 'lesson', 'author', 'seq', 't', 'page', 'act'];

function variant(act: string, props: Record<string, unknown>, req: string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: { ...base, act: { const: act }, ...props },
    required: [...baseReq, ...req],
  };
}

export const boardEventSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://muhsinengin.com/schemas/board-event-v1.json',
  title: 'Çizgi protokolü v1 olayı',
  oneOf: [
    variant('basla', {
      stroke: strokeId,
      tool: { enum: ['kalem', 'vurgu', 'silgi_alan', 'cizgi', 'cember'] },
      w: { type: 'number', exclusiveMinimum: 0, maximum: 0.2 },
      color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
      pts,
    }, ['stroke', 'tool', 'w', 'color', 'pts']),
    variant('ciz', { stroke: strokeId, pts }, ['stroke', 'pts']),
    variant('bitir', { stroke: strokeId, pts }, ['stroke', 'pts']),
    variant('sil', { target: ids }, ['target']),
    variant('geri_getir', { target: ids }, ['target']),
    variant('tasi', { target: ids, dx: coord, dy: coord }, ['target', 'dx', 'dy']),
    variant('sayfa_ekle', {
      kind: { enum: ['bos', 'kareli', 'cizgili', 'koordinat', 'pdf', 'soru'] },
      src: { type: 'string', maxLength: 512 },
    }, ['kind']),
    variant('sayfa_gec', {}, []),
    variant('gorsel_ekle', {
      id: { type: 'string', maxLength: 64 }, src: { type: 'string', maxLength: 512 },
      x: coord, y: coord, w: coord, h: coord,
    }, ['id', 'src', 'x', 'y', 'w', 'h']),
    variant('metin_ekle', {
      id: { type: 'string', maxLength: 64 }, text: { type: 'string', maxLength: 2000 },
      latex: { type: 'boolean' }, x: coord, y: coord, size: { type: 'number', exclusiveMinimum: 0, maximum: 0.5 },
    }, ['id', 'text', 'latex', 'x', 'y', 'size']),
  ],
} as const;
