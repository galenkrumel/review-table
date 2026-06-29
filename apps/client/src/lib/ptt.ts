// Push-to-talk capture. Hold-to-talk: press starts the mic, release
// stops it and yields one bounded clip the server batch-transcribes (SttAdapter). No
// streaming STT, no VAD — the button press is the end-of-utterance signal, and pairing
// it with server-side dog-muting is what lets us skip echo cancellation entirely.

export class PttRecorder {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  /** Open the mic and start recording. Throws if permission is denied. */
  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    const mime = pickMime();
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start();
  }

  /** Stop recording and return the assembled clip (releases the mic). */
  async stop(): Promise<Blob> {
    const recorder = this.recorder;
    if (!recorder) return new Blob([]);
    const done = new Promise<Blob>((resolve) => {
      recorder.onstop = () =>
        resolve(new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" }));
    });
    recorder.stop();
    const clip = await done;
    this.release();
    return clip;
  }

  /** Tear down without using the clip (e.g. an aborted hold). */
  release(): void {
    this.stream?.getTracks().forEach((t) => {
      t.stop();
    });
    this.stream = null;
    this.recorder = null;
  }
}

function pickMime(): string | null {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  for (const m of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return null;
}
