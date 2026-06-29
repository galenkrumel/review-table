// ElevenLabs TtsAdapter. Streams audio from the text-to-speech streaming endpoint
// (no SDK needed — global fetch). Returns MP3 chunks the server forwards to the
// client over the WebSocket. Key is read from env, server-side only (NFR-3).

import type { SttAdapter, TtsAdapter } from "@review-table/contracts";
import { ELEVENLABS_API_KEY, ELEVENLABS_MODEL, ELEVENLABS_STT_MODEL } from "../env";

export class ElevenLabsTtsAdapter implements TtsAdapter {
  async *streamSpeech(args: { voice_id: string; text: string }): AsyncIterable<Uint8Array> {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      args.voice_id,
    )}/stream?output_format=mp3_44100_128`;

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "content-type": "application/json",
        accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: args.text,
        model_id: ELEVENLABS_MODEL,
        voice_settings: { stability: 0.4, similarity_boost: 0.8 },
      }),
    });

    if (!resp.ok || !resp.body) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`ElevenLabs TTS failed: ${resp.status} ${resp.statusText} ${detail}`);
    }

    const reader = resp.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  }
}

// ElevenLabs Scribe SttAdapter (M4). Batch-transcribes the whole PTT clip — the clip
// is a bounded, single-speaker recording, so no streaming STT is needed. Multipart
// upload over global fetch (no SDK). Key is server-side only (NFR-3).
export class ElevenLabsSttAdapter implements SttAdapter {
  async transcribe(args: { audio: Uint8Array; mime: string }): Promise<string> {
    const form = new FormData();
    form.append("model_id", ELEVENLABS_STT_MODEL);
    // Copy into a standalone ArrayBuffer so Blob gets a clean, correctly-sized view.
    const bytes = args.audio.slice();
    form.append("file", new Blob([bytes], { type: args.mime || "audio/webm" }), "ptt.webm");

    const resp = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": ELEVENLABS_API_KEY },
      body: form,
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new Error(`ElevenLabs STT failed: ${resp.status} ${resp.statusText} ${detail}`);
    }
    const data: any = await resp.json();
    return (data.text ?? "").trim();
  }
}
