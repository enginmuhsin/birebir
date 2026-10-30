/**
 * Yayın taşıyıcısı. Tahta kodu yalnız bu arayüzü görür; altta yerel WebSocket (prototip/test),
 * Supabase Realtime Broadcast ya da WebRTC DataChannel olabilir.
 */
export type Status = 'baglaniyor' | 'bagli' | 'kopuk';

export interface Transport {
  connect(): void;
  send(event: string, payload: unknown, lossy?: boolean): boolean;
  on(event: string, cb: (payload: any) => void): void;
  onStatus(cb: (s: Status) => void): void;
  /** Test kancası: bağlantıyı kopar ve ms boyunca yeniden bağlanmayı engelle. */
  drop?(ms: number): void;
}

export class LocalWsTransport implements Transport {
  private ws?: WebSocket;
  private handlers = new Map<string, ((p: any) => void)[]>();
  private statusCb: (s: Status) => void = () => {};
  private blockedUntil = 0;
  private retry = 250;
  constructor(private url: string, private topic: string) {}

  connect() {
    if (Date.now() < this.blockedUntil) { setTimeout(() => this.connect(), this.blockedUntil - Date.now()); return; }
    this.statusCb('baglaniyor');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'join', topic: this.topic }));
    ws.onmessage = ev => {
      const m = JSON.parse(ev.data as string);
      if (m.type === 'joined') { this.retry = 250; this.statusCb('bagli'); return; }
      if (m.type === 'broadcast') for (const cb of this.handlers.get(m.event) ?? []) cb(m.payload);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.statusCb('kopuk');
      const wait = Math.max(this.retry, this.blockedUntil - Date.now());
      this.retry = Math.min(this.retry * 2, 4000);
      setTimeout(() => this.connect(), wait);
    };
  }
  send(event: string, payload: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ type: 'broadcast', topic: this.topic, event, payload }));
    return true;
  }
  on(event: string, cb: (p: any) => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]); }
  onStatus(cb: (s: Status) => void) { this.statusCb = cb; }
  drop(ms: number) { this.blockedUntil = Date.now() + ms; this.ws?.close(); }
}

/**
 * Supabase Realtime Broadcast taşıyıcısı. GERÇEK SERVİSLE DENENMEDİ (Aşama 0'da Supabase erişimi yoktu).
 * Özel kanal (private: true) kullanır; yetki RLS politikasıyla realtime.messages üzerinden verilir (Aşama 1).
 */
export class SupabaseTransport implements Transport {
  private channel: any;
  private handlers: [string, (p: any) => void][] = [];
  private statusCb: (s: Status) => void = () => {};
  constructor(private client: any, private topic: string) {}
  connect() {
    this.statusCb('baglaniyor');
    this.channel = this.client.channel(this.topic, { config: { private: true, broadcast: { self: false, ack: false } } });
    for (const [ev, cb] of this.handlers) this.channel.on('broadcast', { event: ev }, (m: any) => cb(m.payload));
    this.channel.subscribe((status: string) => {
      if (status === 'SUBSCRIBED') this.statusCb('bagli');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') this.statusCb('kopuk');
    });
  }
  send(event: string, payload: unknown): boolean {
    if (!this.channel) return false;
    this.channel.send({ type: 'broadcast', event, payload });
    return true;
  }
  on(event: string, cb: (p: any) => void) { this.handlers.push([event, cb]); }
  onStatus(cb: (s: Status) => void) { this.statusCb = cb; }
}
