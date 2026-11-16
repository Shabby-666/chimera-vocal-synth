/**
 * Import a Standard MIDI File that carries lyrics: parse its melody and lyric events into a Tune
 * the Sing screen can play (a syllable to each note, as the engine's demo songs are).
 *
 * Lyrics come from Lyric meta events (0xFF 0x05) and, where absent, Text meta events (0xFF 0x01).
 * Each lyric is attached to a note in order; a leading/trailing space marks a word boundary, a
 * trailing "-" marks a syllable inside a word, and "\" / "/" mark a line break (a phrase end).
 */

import type { Syllable } from "../wasm/types.ts";
import type { Tune } from "./tunes.ts";
import { lyricsToSyllables } from "../wasm/engine.ts";

interface RawNote {
  midi: number;
  /** start, in ticks from the file's origin */
  tick: number;
  /** length in ticks */
  dur: number;
}

interface RawLyric {
  tick: number;
  text: string;
}

function readStr(buf: Uint8Array, off: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[off + i]);
  return s;
}

function readU16(buf: Uint8Array, off: number): number {
  return (buf[off] << 8) | buf[off + 1];
}

function readU32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

/** Read a variable-length quantity; returns [value, bytes consumed]. */
function readVLQ(buf: Uint8Array, off: number): [number, number] {
  let v = 0;
  let i = 0;
  for (; i < 4; i++) {
    const b = buf[off + i];
    v = (v << 7) | (b & 0x7f);
    if ((b & 0x80) === 0) return [v, i + 1];
  }
  return [v, i];
}

export interface MidiSong {
  name: string;
  tune: Tune;
}

/**
 * Parse a MIDI file into a singable tune. Throws with a short reason when the file has no notes
 * (or no melody that can be sung).
 */
export function parseMidi(buffer: ArrayBuffer, fileName = "Imported"): MidiSong {
  const buf = new Uint8Array(buffer);
  if (buf.length < 14 || readStr(buf, 0, 4) !== "MThd") throw new Error("not a MIDI file");
  const headerLen = readU32(buf, 4);
  const format = readU16(buf, 8);
  const ntrks = readU16(buf, 10);
  const division = readU16(buf, 12);
  if (division & 0x8000) throw new Error("SMPTE timecode MIDI files are not supported");
  const tpq = division || 480; // ticks per quarter note

  let off = 8 + headerLen;
  const notes: RawNote[] = [];
  const lyrics: RawLyric[] = [];
  let usPerQuarter = 500000; // 120 BPM
  let trackName = "";

  for (let t = 0; t < ntrks && off + 8 <= buf.length; t++) {
    if (readStr(buf, off, 4) !== "MTrk") break;
    const len = readU32(buf, off + 4);
    const end = Math.min(buf.length, off + 8 + len);
    let p = off + 8;
    let tick = 0;
    let status = 0;
    // sounding notes per channel*128 + note: start tick (stack for re-triggers)
    const on: number[][] = Array.from({ length: 16 * 128 }, () => []);
    while (p < end) {
      const [delta, dv] = readVLQ(buf, p);
      p += dv;
      tick += delta;
      if (p >= end) break;
      let b = buf[p];
      if (b < 0x80) {
        // running status
        b = status;
      } else {
        p++;
        if (b < 0xf0) status = b;
      }
      const hi = b & 0xf0;
      if (hi === 0x90 || hi === 0x80) {
        if (p + 1 > end) break;
        const note = buf[p++];
        const vel = buf[p++];
        const idx = (b & 0x0f) * 128 + note;
        if (hi === 0x90 && vel > 0) {
          on[idx].push(tick);
        } else {
          const start = on[idx].pop();
          if (start !== undefined) notes.push({ midi: note, tick: start, dur: Math.max(1, tick - start) });
        }
      } else if (hi === 0xa0 || hi === 0xb0 || hi === 0xe0) {
        p += 2;
      } else if (hi === 0xc0 || hi === 0xd0) {
        p += 1;
      } else if (b === 0xff) {
        if (p >= end) break;
        const type = buf[p++];
        const [mlen, mv] = readVLQ(buf, p);
        p += mv;
        const dataOff = p;
        p = Math.min(end, p + mlen);
        if (type === 0x51 && mlen === 3) {
          usPerQuarter = (buf[dataOff] << 16) | (buf[dataOff + 1] << 8) | buf[dataOff + 2];
        } else if (type === 0x03 && !trackName) {
          trackName = decodeText(buf, dataOff, mlen).trim();
        } else if (type === 0x05 || type === 0x01) {
          const text = decodeText(buf, dataOff, mlen);
          if (text.trim()) lyrics.push({ tick, text });
        }
      } else if (b === 0xf0 || b === 0xf7) {
        const [mlen, mv] = readVLQ(buf, p);
        p += mv + mlen;
      } else {
        // unknown, try to continue
        if (b >= 0x80) status = 0;
      }
    }
    // close any hanging notes at track end
    for (let i = 0; i < on.length; i++) for (const start of on[i]) if (tick > start) notes.push({ midi: i % 128, tick: start, dur: tick - start });
    off = end;
  }

  if (!notes.length) throw new Error("the MIDI file has no notes");

  // melody: if multiple notes overlap, keep the highest at each onset (a simple vocal line guess)
  notes.sort((a, b) => a.tick - b.tick || b.midi - a.midi);
  const melody: RawNote[] = [];
  let lastEnd = -1;
  for (const n of notes) {
    if (n.tick >= lastEnd - 1) {
      melody.push(n);
      lastEnd = n.tick + n.dur;
    } else if (melody.length && n.midi > melody[melody.length - 1].midi) {
      // overlapping: prefer the higher note
      const prev = melody[melody.length - 1];
      prev.dur = Math.max(1, n.tick - prev.tick);
      melody.push(n);
      lastEnd = n.tick + n.dur;
    }
  }
  if (!melody.length) throw new Error("the MIDI file has no melody notes");

  lyrics.sort((a, b) => a.tick - b.tick);

  const bpm = Math.max(30, Math.min(240, Math.round(60000000 / (usPerQuarter || 500000))));
  const phrases = [melody.map((n): [number, number] => [n.midi, Math.max(0.125, n.dur / tpq)])];

  const base = (fileName.replace(/\.[^.]+$/, "") || trackName || "Imported").trim() || "Imported";
  const id = `midi:${base}:${Date.now().toString(36)}`;

  // Build lyrics aligned to notes. Prefer lyric events; fall back to "la" per note.
  let lyricsText: string | undefined;
  let lyricSyls: Syllable[] | undefined;
  if (lyrics.length) {
    const built = buildLyrics(melody, lyrics);
    lyricsText = built.text;
    // Parse the reconstructed text into syllables with phonemes via the engine's G2P.
    lyricSyls = lyricsToSyllables(lyricsText);
    // If syllable count doesn't match notes, keep text for display but don't claim a 1:1 lyric map
    // (playback will fit words to the melody). This keeps singing working even with odd MIDI lyrics.
    if (lyricSyls.length !== melody.length) {
      // try per-token phonemes so each note still gets a syllable
      const tokens = built.tokens;
      if (tokens.length === melody.length) {
        lyricSyls = tokens.map((tok, i) => syllableFromToken(tok, i === melody.length - 1));
        lyricsText = built.text;
      } else {
        lyricsText = undefined;
        lyricSyls = undefined;
      }
    }
  }

  const tune: Tune = {
    id,
    name: base,
    bpm,
    octave: { male: -1, female: 0, child: 0 },
    phrases,
    lyrics: lyricsText,
  };

  // Attach precomputed 1:1 syllables for exact MIDI lyric alignment (used when present).
  if (lyricSyls && lyricsText && lyricSyls.length === melody.length) {
    (tune as Tune & { midiSyllables?: Syllable[] }).midiSyllables = lyricSyls;
  }

  return { name: base, tune };
}

function decodeText(buf: Uint8Array, off: number, len: number): string {
  try {
    return new TextDecoder("utf-8").decode(buf.subarray(off, off + len));
  } catch {
    return readStr(buf, off, len);
  }
}

function buildLyrics(notes: RawNote[], lyrics: RawLyric[]): { text: string; tokens: string[] } {
  // assign lyrics to notes in time order: take lyrics up to (and around) each note tick
  const tokens: string[] = [];
  let li = 0;
  for (let i = 0; i < notes.length; i++) {
    const nextTick = i + 1 < notes.length ? notes[i + 1].tick : Infinity;
    let tok = "";
    // gather lyric events that belong to this note (before next note)
    while (li < lyrics.length && lyrics[li].tick < nextTick - 1) {
      tok += lyrics[li++].text;
      if (li < lyrics.length && lyrics[li].tick > notes[i].tick + notes[i].dur) break;
    }
    // if nothing gathered, try any lyric very close to this note
    if (!tok && li < lyrics.length && Math.abs(lyrics[li].tick - notes[i].tick) <= notes[i].dur) {
      tok = lyrics[li++].text;
    }
    tokens.push(tok || "la");
  }
  // consume any trailing lyrics into last token
  while (li < lyrics.length) tokens[tokens.length - 1] += lyrics[li++].text;

  let text = "";
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i].replace(/\r\n?/g, "\n");
    const lineBreak = /[\\\/]/.test(t);
    t = t.replace(/[\\\/]/g, "");
    const hadSpace = /^\s/.test(t) || /\s$/.test(t);
    const core = t.trim();
    const hyphen = core.endsWith("-");
    const clean = hyphen ? core.slice(0, -1) : core;
    text += clean;
    if (lineBreak) text += "\n";
    else if (hyphen) text += "-"; // keep inside-word marker for display; syllabifier may see it
    else if (i < tokens.length - 1) text += hadSpace || !clean ? " " : " ";
  }
  return { text: text.trim(), tokens: tokens.map((t) => t.replace(/[\\\/\r\n]/g, " ").trim() || "la") };
}

/** Build a minimal syllable from a raw MIDI lyric token (best-effort phonemes via G2P). */
function syllableFromToken(token: string, phraseEnd: boolean): Syllable {
  const t = token.replace(/[\\\/]/g, "").trim();
  const wordEnd = !t.endsWith("-") && !/^-/.test(t) ? true : !t.endsWith("-");
  const melisma = t === "-" || t === "~";
  const clean = t.replace(/^-+|-+$/g, "") || (melisma ? "~" : "la");
  // ask the engine to syllabify this token so we get phonemes; fall back to "la"
  let syls: Syllable[] = [];
  try {
    syls = lyricsToSyllables(clean);
  } catch {
    syls = [];
  }
  if (syls.length === 1) {
    return { ...syls[0], text: clean, melisma, wordEnd, phraseEnd };
  }
  if (syls.length > 1) {
    // merge into one syllable's nucleus/onset/coda crudely by taking first
    return { ...syls[0], text: clean, melisma, wordEnd, phraseEnd };
  }
  return { text: clean, onset: [], nucleus: { ipa: "ɑ", stress: 1 }, coda: [], melisma, wordEnd, phraseEnd };
}
