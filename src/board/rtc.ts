/**
 * Eşten eşe WebRTC bağlantısı: ses + görüntü + tahta veri kanalı.
 * Sinyalleşme yayın kanalından ('rtc' olayı) yapılır. Öğretmen her zaman teklif (offer) veren taraftır.
 * Kopma ya da başarısızlıkta öğrenci 'merhaba' gönderir, öğretmen bağlantıyı sıfırdan kurar.
 */
import type { Status, Transport } from './transport.js';

export interface RtcOptions {
  role: 'T' | 'S';
  iceServers: RTCIceServer[];
  media: MediaStream | null;
  onRemoteStream: (s: MediaStream) => void;
  onState: (s: string) => void;
  /** Bant genişliği düşünce görüntü kapatıldı/açıldı bildirimi. */
  onVideoSuspended?: (suspended: boolean) => void;
}

type Handler = (payload: any) => void;

export class RtcLink {
  pc: RTCPeerConnection | null = null;
  board: RTCDataChannel | null = null;
  laser: RTCDataChannel | null = null;
  private handlers = new Map<string, Handler[]>();
  private helloTimer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private videoSuspended = false;
  reconnects = 0;

  constructor(private signal: Transport, private o: RtcOptions) {
    signal.on('rtc', m => this.onSignal(m));
    setInterval(() => this.watchBandwidth(), 2000);
  }

  get open() { return this.board?.readyState === 'open'; }

  on(event: string, cb: Handler) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]); }
  private emit(event: string, payload: any) { for (const h of this.handlers.get(event) ?? []) h(payload); }

  /** Sinyal kanalı bağlanınca çağrılır. */
  signalUp() {
    if (this.o.role === 'S') this.sayHello();
  }

  private sayHello() {
    if (this.helloTimer) return;
    const hello = () => { if (this.open) { clearInterval(this.helloTimer!); this.helloTimer = null; return; } this.signal.send('rtc', { k: 'hello' }); };
    hello();
    this.helloTimer = setInterval(hello, 3000);
  }

  private newPc(): RTCPeerConnection {
    this.pc?.close();
    const gen = ++this.generation;
    const pc = new RTCPeerConnection({ iceServers: this.o.iceServers });
    this.pc = pc;
    pc.onicecandidate = e => { if (e.candidate && gen === this.generation) this.signal.send('rtc', { k: 'ice', gen, c: e.candidate.toJSON() }); };
    pc.ontrack = e => this.o.onRemoteStream(e.streams[0] ?? new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      if (gen !== this.generation) return;
      this.o.onState(pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        // 3 sn içinde kendiliğinden düzelmezse sıfırdan kur
        setTimeout(() => {
          if (gen === this.generation && pc.connectionState !== 'connected') {
            this.reconnects++;
            if (this.o.role === 'S') this.sayHello(); else this.signal.send('rtc', { k: 'restart' });
          }
        }, 3000);
      }
    };
    pc.ondatachannel = e => this.attach(e.channel);
    if (this.o.media) for (const t of this.o.media.getTracks()) {
      const sender = pc.addTrack(t, this.o.media);
      // ses öncelikli; görüntü 360p / 500 kbps sınırında
      const p = sender.getParameters();
      if (!p.encodings?.length) p.encodings = [{}];
      if (t.kind === 'audio') { p.encodings[0].priority = 'high'; p.encodings[0].networkPriority = 'high'; }
      else { p.encodings[0].maxBitrate = 500_000; p.encodings[0].priority = 'low'; (p as any).degradationPreference = 'maintain-framerate'; }
      sender.setParameters(p).catch(() => { /* bağlantıdan önce bazı tarayıcılar reddeder; bağlanınca yeniden denenir */ });
    }
    return pc;
  }

  private attach(ch: RTCDataChannel) {
    if (ch.label === 'board') this.board = ch; else this.laser = ch;
    ch.onopen = () => { if (ch.label === 'board') { this.emit('__open', null); this.o.onState('veri kanalı açık'); } };
    ch.onclose = () => { if (ch.label === 'board') { this.emit('__close', null); if (this.o.role === 'S') this.sayHello(); } };
    ch.onmessage = ev => { const m = JSON.parse(ev.data); this.emit(m.e, m.p); };
  }

  private async offer() {
    const pc = this.newPc();
    this.attach(pc.createDataChannel('board', { ordered: true }));
    this.attach(pc.createDataChannel('laser', { ordered: false, maxRetransmits: 0 }));
    await pc.setLocalDescription(await pc.createOffer());
    this.signal.send('rtc', { k: 'offer', gen: this.generation, sdp: pc.localDescription });
  }

  private remoteGen = 0;
  private async onSignal(m: any) {
    try {
      if (m.k === 'hello' && this.o.role === 'T') await this.offer();
      else if (m.k === 'restart' && this.o.role === 'S') this.sayHello();
      else if (m.k === 'offer' && this.o.role === 'S') {
        const pc = this.newPc();
        this.remoteGen = m.gen;
        await pc.setRemoteDescription(m.sdp);
        await pc.setLocalDescription(await pc.createAnswer());
        this.signal.send('rtc', { k: 'answer', gen: m.gen, sdp: pc.localDescription });
      } else if (m.k === 'answer' && this.o.role === 'T' && m.gen === this.generation) {
        await this.pc!.setRemoteDescription(m.sdp);
      } else if (m.k === 'ice' && this.pc) {
        const mine = this.o.role === 'T' ? this.generation : this.remoteGen;
        if (m.gen === mine) await this.pc.addIceCandidate(m.c);
      }
    } catch (e) { console.warn('rtc', e); }
  }

  send(event: string, payload: unknown, lossy = false): boolean {
    const ch = lossy ? this.laser : this.board;
    if (!ch || ch.readyState !== 'open') return false;
    ch.send(JSON.stringify({ e: event, p: payload }));
    return true;
  }

  /** Test kancası: veri kanalını kapat (yedeğe düşme testi). */
  breakChannel() { this.board?.close(); this.laser?.close(); }

  private async watchBandwidth() {
    const pc = this.pc;
    if (!pc || pc.connectionState !== 'connected') return;
    const stats = await pc.getStats();
    let avail: number | undefined;
    stats.forEach(r => { if (r.type === 'candidate-pair' && r.nominated && r.availableOutgoingBitrate) avail = r.availableOutgoingBitrate; });
    if (avail === undefined) return;
    const suspend = avail < 150_000, resume = avail > 400_000;
    if ((suspend && !this.videoSuspended) || (resume && this.videoSuspended)) {
      this.videoSuspended = suspend;
      for (const s of pc.getSenders()) if (s.track?.kind === 'video') {
        const p = s.getParameters(); if (p.encodings?.[0]) { p.encodings[0].active = !suspend; await s.setParameters(p).catch(() => {}); }
      }
      this.o.onVideoSuspended?.(suspend);
    }
  }

  async stats() {
    const out = { audioIn: 0, videoIn: 0, framesDecoded: 0, rtt: 0, relay: false };
    if (!this.pc) return out;
    (await this.pc.getStats()).forEach(r => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') out.audioIn = r.bytesReceived;
      if (r.type === 'inbound-rtp' && r.kind === 'video') { out.videoIn = r.bytesReceived; out.framesDecoded = r.framesDecoded ?? 0; }
      if (r.type === 'candidate-pair' && r.nominated) out.rtt = r.currentRoundTripTime ?? 0;
    });
    return out;
  }
}

/**
 * Tahta taşıyıcısı: veri kanalı açıksa oradan, değilse yayın kanalından gönderir; ikisinden de dinler.
 * Aynı olay iki yoldan gelirse tahta durumu seq ile tekrarı ayıklar.
 */
export class HybridTransport implements Transport {
  viaDc = 0; viaBc = 0;
  constructor(private bc: Transport, private rtc: RtcLink | null, public force: 'auto' | 'bc' = 'auto') {}
  connect() { this.bc.connect(); }
  send(event: string, payload: unknown, lossy = false): boolean {
    if (this.force === 'auto' && this.rtc?.send(event, payload, lossy)) { this.viaDc++; return true; }
    this.viaBc++;
    return this.bc.send(event, payload);
  }
  on(event: string, cb: (p: any) => void) { this.bc.on(event, cb); this.rtc?.on(event, cb); }
  onStatus(cb: (s: Status) => void) { this.bc.onStatus(cb); }
  drop(ms: number) { this.bc.drop?.(ms); }
}
