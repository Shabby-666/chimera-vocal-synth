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

interface TrackData {
  name: string;
  notes: RawNote[];
  lyrics: RawLyric[];
  /** tempo events (us per quarter) with their tick */
  tempos: { tick: number; us: number }[];
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
  const tracks: TrackData[] = [];

  for (let t = 0; t < ntrks && off + 8 <= buf.length; t++) {
    if (readStr(buf, off, 4) !== "MTrk") break;
    const len = readU32(buf, off + 4);
    const end = Math.min(buf.length, off + 8 + len);
    let p = off + 8;
    let tick = 0;
    let status = 0;
    const td: TrackData = { name: "", notes: [], lyrics: [], tempos: [] };
    // active note start tick per channel*128 + note (-1 if off)
    const on: Int32Array = new Int32Array(16 * 128).fill(-1);
    while (p < end) {
      const [delta, dv] = readVLQ(buf, p);
      p += dv;
      tick += delta;
      if (p >= end) break;
      let b = buf[p];
      if (b < 0x80) {
        // running status: b is the first data byte
        b = status;
      } else {
        p++;
        if (b < 0xf0) status = b;
        else status = 0; // system common/real-time cancel running status
      }
      if (b === 0) {
        // no valid running status; skip a byte to avoid stalling
        continue;
      }
      const hi = b & 0xf0;
      if (hi === 0x90 || hi === 0x80) {
        if (p + 1 > end) break;
        const note = buf[p++];
        const vel = buf[p++];
        const idx = (b & 0x0f) * 128 + note;
        const isOn = hi === 0x90 && vel > 0;
        if (isOn) {
          if (on[idx] >= 0 && tick > on[idx]) {
            // re-trigger: close previous note
            td.notes.push({ midi: note, tick: on[idx], dur: tick - on[idx] });
          }
          on[idx] = tick;
        } else {
          if (on[idx] >= 0) {
            td.notes.push({ midi: note, tick: on[idx], dur: Math.max(1, tick - on[idx]) });
            on[idx] = -1;
          }
        }
      } else if (hi === 0xa0 || hi === 0xb0 || hi === 0xe0) {
        p = Math.min(end, p + 2);
      } else if (hi === 0xc0 || hi === 0xd0) {
        p = Math.min(end, p + 1);
      } else if (b === 0xff) {
        if (p >= end) break;
        const type = buf[p++];
        const [mlen, mv] = readVLQ(buf, p);
        p += mv;
        const dataOff = p;
        p = Math.min(end, p + mlen);
        if (type === 0x51 && mlen === 3) {
          td.tempos.push({ tick, us: (buf[dataOff] << 16) | (buf[dataOff + 1] << 8) | buf[dataOff + 2] });
        } else if (type === 0x03 && !td.name) {
          td.name = decodeText(buf, dataOff, mlen).trim();
        } else if (type === 0x05 || type === 0x01) {
          const text = decodeText(buf, dataOff, mlen);
          if (text.trim()) td.lyrics.push({ tick, text });
        }
      } else if (b === 0xf0 || b === 0xf7) {
        const [mlen, mv] = readVLQ(buf, p);
        p = Math.min(end, p + mv + mlen);
      } else {
        // unknown; running status already cleared for system messages above
      }
    }
    // close any hanging notes at track end
    for (let i = 0; i < on.length; i++) if (on[i] >= 0 && tick > on[i]) td.notes.push({ midi: i % 128, tick: on[i], dur: tick - on[i] });
    td.notes.sort((a, b) => a.tick - b.tick || a.midi - b.midi);
    td.lyrics.sort((a, b) => a.tick - b.tick);
    tracks.push(td);
    off = end;
  }

  const allLyrics = tracks.flatMap((tr) => tr.lyrics).sort((a, b) => a.tick - b.tick);
  const tempos = tracks.flatMap((tr) => tr.tempos).sort((a, b) => a.tick - b.tick);
  const usPerQuarter = tempos.length ? tempos[0].us : 500000; // initial tempo for a single-BPM tune

  const noteTracks = tracks.filter((tr) => tr.notes.length);
  if (!noteTracks.length) throw new Error("the MIDI file has no notes");

  const melodyTrack = pickMelodyTrack(noteTracks, allLyrics, tpq);
  const melody = toMonophonic(melodyTrack.notes);
  if (!melody.length) throw new Error("the MIDI file has no melody notes");

  const lyrics = allLyrics;

  const bpm = Math.max(30, Math.min(240, Math.round(60000000 / (usPerQuarter || 500000))));
  const phrases = [melody.map((n): [number, number] => [n.midi, Math.max(0.0625, n.dur / tpq)])];

  const base = (fileName.replace(/\.[^.]+$/, "") || melodyTrack.name || tracks.find((tr) => tr.name)?.name || "Imported").trim() || "Imported";
  const id = `midi:${base}:${Date.now().toString(36)}`;

  // Build lyrics aligned to notes. Prefer lyric events; fall back to "la" per note.
  let lyricsText: string | undefined;
  let lyricSyls: Syllable[] | undefined;
  if (lyrics.length) {
    const built = buildLyrics(melody, lyrics);
    lyricsText = built.text;
    try {
      lyricSyls = lyricsToSyllables(lyricsText);
    } catch {
      lyricSyls = [];
    }
    if (!lyricSyls || lyricSyls.length !== melody.length) {
      // try per-token phonemes so each note still gets a syllable
      const tokens = built.tokens;
      if (tokens.length === melody.length) {
        lyricSyls = tokens.map((tok, i) => syllableFromToken(tok, i === melody.length - 1));
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

/** Choose the track most likely to be the vocal melody. */
function pickMelodyTrack(tracks: TrackData[], lyrics: RawLyric[], tpq: number): TrackData {
  if (tracks.length === 1) return tracks[0];
  let best = tracks[0];
  let bestScore = -Infinity;
  for (const tr of tracks) {
    const notes = tr.notes;
    if (!notes.length) continue;
    const n = notes.length;
    let vocal = 0;
    for (const note of notes) if (note.midi >= 36 && note.midi <= 84) vocal++;
    const vocalRatio = vocal / n;
    // monophony: how often a new note starts after the previous ended
    let mono = 0;
    for (let i = 1; i < notes.length; i++) if (notes[i].tick >= notes[i - 1].tick + notes[i - 1].dur - 1) mono++;
    const monoRatio = notes.length > 1 ? mono / (notes.length - 1) : 1;
    let lyricAlign = 0;
    if (lyrics.length) {
      const a = notes[0].tick;
      const b = notes[notes.length - 1].tick + notes[notes.length - 1].dur;
      for (const l of lyrics) if (l.tick >= a - tpq && l.tick <= b + tpq) lyricAlign++;
      lyricAlign /= Math.max(1, lyrics.length);
    }
    const name = tr.name.toLowerCase();
    const nameBonus = /vocal|melody|voice|sing|lyric|lead|mel|メロディ|歌/.test(name) ? 1.5 : 0;
    const score = vocalRatio * 2 + monoRatio * 1.5 + lyricAlign * 3 + nameBonus + Math.min(n, 500) / 500;
    if (score > bestScore) {
      bestScore = score;
      best = tr;
    }
  }
  return best;
}

/** Reduce a note list to a single monophonic line (highest note where overlapping). */
function toMonophonic(notes: RawNote[]): RawNote[] {
  if (!notes.length) return [];
  const sorted = [...notes].sort((a, b) => a.tick - b.tick || b.midi - a.midi || b.dur - a.dur);
  const out: RawNote[] = [];
  for (const n of sorted) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push({ ...n });
      continue;
    }
    const prevEnd = prev.tick + prev.dur;
    if (n.tick >= prevEnd - 1) {
      // small gap/overlap at boundary: start next at/after previous end
      if (n.tick < prevEnd) {
        prev.dur = Math.max(1, n.tick - prev.tick);
      }
      out.push({ ...n });
    } else {
      // overlapping notes: keep the higher-pitched one
      if (n.midi > prev.midi) {
        prev.dur = Math.max(1, n.tick - prev.tick);
        if (prev.dur <= 1 && n.tick <= prev.tick) {
          out[out.length - 1] = { ...n };
        } else {
          out.push({ ...n });
        }
      } else if (n.tick + n.dur > prevEnd) {
        // lower note extends beyond: keep as continuation after prev ends
        out.push({ midi: n.midi, tick: prevEnd, dur: n.tick + n.dur - prevEnd });
      }
    }
  }
  // remove zero/negative durations and sort
  return out.filter((n) => n.dur > 0).sort((a, b) => a.tick - b.tick);
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
