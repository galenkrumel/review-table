// Client audio + lip-sync (ARCHITECTURE.md §4). Playback is client-side: accumulate
// the turn's streamed audio frames, decode, play through Web Audio, tap an
// AnalyserNode for short-window RMS amplitude, and map that to the speaking dog's
// mouth state (closed / mid / open). M2 accumulates-then-plays; true sentence-level
// streaming playback is an M3/M5 latency upgrade.

export type MouthState = "closed" | "mid" | "open";

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private chunks: Uint8Array[] = [];
  private analyser: AnalyserNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private raf = 0;
  private playing = false;

  constructor(
    private readonly onMouth: (state: MouthState) => void,
    private readonly onEnded: () => void,
  ) {}

  /** Create/resume the AudioContext from within a user gesture (the Start click). */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  /** Start collecting a new turn's audio. */
  begin(): void {
    this.stop();
    this.chunks = [];
  }

  push(buf: ArrayBuffer): void {
    this.chunks.push(new Uint8Array(buf));
  }

  /**
   * All frames received — decode, play, and drive the mouth from amplitude. The
   * returned promise resolves when playback actually ends, so the caller can play
   * turns strictly one at a time (no overlap as the server streams the whole review).
   */
  async end(): Promise<void> {
    if (!this.ctx || this.chunks.length === 0) {
      this.onEnded();
      return;
    }
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let off = 0;
    for (const c of this.chunks) {
      merged.set(c, off);
      off += c.length;
    }
    this.chunks = [];

    let audioBuf: AudioBuffer;
    try {
      // decodeAudioData wants an ArrayBuffer; slice to a fresh one.
      audioBuf = await this.ctx.decodeAudioData(merged.buffer.slice(0));
    } catch (err) {
      console.error("[audio] decode failed:", err);
      this.onEnded();
      return;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = audioBuf;
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    this.analyser = analyser;
    source.connect(analyser);
    analyser.connect(this.ctx.destination);
    this.source = source;

    this.playing = true;
    await new Promise<void>((resolve) => {
      source.onended = () => {
        if (this.source === source) this.source = null;
        this.playing = false;
        cancelAnimationFrame(this.raf);
        this.onMouth("closed");
        this.onEnded();
        resolve();
      };
      source.start();
      this.animate();
    });
  }

  /** Stop any in-flight playback (e.g. a new review starts). Fires the end handler. */
  interrupt(): void {
    try {
      this.source?.stop();
    } catch {
      /* already stopped */
    }
  }

  private animate = (): void => {
    if (!this.playing || !this.analyser) return;
    const buf = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(buf);
    // RMS of the centered waveform.
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i]! - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    this.onMouth(rms > 0.22 ? "open" : rms > 0.08 ? "mid" : "closed");
    this.raf = requestAnimationFrame(this.animate);
  };

  private stop(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
  }
}
