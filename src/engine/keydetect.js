/**
 * Estimate musical key when audio is available without a matching MIDI file.
 *
 * Uses standard Krumhansl key-profile matching: audio becomes a 12-bin chroma
 * vector, which is correlated with 24 major/minor templates.
 *
 * The chroma vector only reads bins between 55 Hz and 2200 Hz, so analysing at
 * the source rate computes roughly ten times more spectrum than it uses.
 * Callers resample through toAnalysisSamples() first, which cuts the work by
 * about six times and improves bin resolution at the same time.
 */

// Krumhansl-Schmuckler key profiles.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** Band-limited to the chroma range, so a 4 kHz Nyquist is ample headroom. */
export const ANALYSIS_RATE = 8000;
export const ANALYSIS_SECONDS = 60;

const LO_HZ = 55;
const HI_HZ = 2200;

/**
 * Downmix to mono, resample to ANALYSIS_RATE, and keep only the leading
 * ANALYSIS_SECONDS. A mono destination performs the downmix for us.
 */
export async function toAnalysisSamples(buffer, OfflineCtx = globalThis.OfflineAudioContext) {
  const seconds = Math.min(buffer.duration, ANALYSIS_SECONDS);
  const frames = Math.max(1, Math.round(seconds * ANALYSIS_RATE));
  const offline = new OfflineCtx(1, frames, ANALYSIS_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

function normalizeInput(input) {
  // Accept an AudioBuffer directly as well as a plain { sampleRate, samples }.
  if (typeof input?.getChannelData === 'function') {
    return { sampleRate: input.sampleRate, samples: input.getChannelData(0) };
  }
  return { sampleRate: input.sampleRate, samples: input.samples };
}

/** Precompute everything that depends only on the rate and the sample count. */
function analysisPlan(sampleRate, sampleCount) {
  // Hold bin resolution near 8 Hz whatever the input rate: 1024 at 8 kHz gives
  // 7.8 Hz, which is finer than the 10.8 Hz that 4096 gives at 44.1 kHz.
  const size = sampleRate <= 12000 ? 1024 : 4096;
  const hop = size >> 1;
  const half = size >> 1;

  const binPitchClass = new Int8Array(half);
  for (let k = 1; k < half; k++) {
    const f = (k * sampleRate) / size;
    binPitchClass[k] = (f >= LO_HZ && f <= HI_HZ)
      ? ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12   // A4=440 -> pc 9
      : -1;
  }

  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));

  const limit = Math.min(sampleCount, Math.floor(sampleRate * ANALYSIS_SECONDS));
  const frameCount = Math.max(0, Math.ceil((limit - size) / hop));

  return {
    size, hop, half, binPitchClass, window, frameCount,
    re: new Float64Array(size), im: new Float64Array(size),
  };
}

/** Fold frames [fromFrame, toFrame) of the signal into the chroma vector. */
function accumulate(samples, plan, chroma, fromFrame, toFrame) {
  const { size, hop, half, binPitchClass, window, re, im } = plan;
  for (let frame = fromFrame; frame < toFrame; frame++) {
    const pos = frame * hop;
    for (let i = 0; i < size; i++) { re[i] = samples[pos + i] * window[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < half; k++) {
      const pc = binPitchClass[k];
      if (pc < 0) continue;
      chroma[pc] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }
  }
}

/**
 * Pearson correlation of chroma against a key profile rotated to `tonic`.
 * Rotation preserves the mean, so the profile is indexed in place rather than
 * copied into a new array for each of the 24 candidates.
 */
function rotatedCorrelation(a, profile, tonic) {
  let meanA = 0, meanB = 0;
  for (let i = 0; i < 12; i++) { meanA += a[i]; meanB += profile[i]; }
  meanA /= 12; meanB /= 12;

  let num = 0, da = 0, db = 0;
  for (let i = 0; i < 12; i++) {
    const x = a[i] - meanA;
    const y = profile[(i - tonic + 12) % 12] - meanB;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function bestKey(chroma) {
  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i];
  if (!total) total = 1;

  const norm = new Float64Array(12);
  for (let i = 0; i < 12; i++) norm[i] = chroma[i] / total;

  let best = { score: -2, tonic: 0, mode: 'major' };
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, profile] of [['major', MAJOR], ['minor', MINOR]]) {
      const score = rotatedCorrelation(norm, profile, tonic);
      if (score > best.score) best = { score, tonic, mode };
    }
  }
  return {
    tonic: best.tonic,
    mode: best.mode,
    name: `${NAMES[best.tonic]} ${best.mode}`,
    confidence: +Math.max(0, best.score).toFixed(2),
  };
}

/**
 * @param input An AudioBuffer, or { sampleRate, samples }.
 * @returns {{tonic:number, mode:'major'|'minor', name:string, confidence:number}}
 */
export function detectKey(input) {
  const { sampleRate, samples } = normalizeInput(input);
  const plan = analysisPlan(sampleRate, samples.length);
  const chroma = new Float64Array(12);
  accumulate(samples, plan, chroma, 0, plan.frameCount);
  return bestKey(chroma);
}

/**
 * The same analysis, yielding to the event loop between chunks so the window
 * keeps painting.
 *
 * A Worker would be the conventional answer, but the packaged app loads from
 * file://, where Chromium refuses to construct one. Chunking needs no origin.
 */
export async function detectKeyAsync(input, { chunkFrames = 32 } = {}) {
  const { sampleRate, samples } = normalizeInput(input);
  const plan = analysisPlan(sampleRate, samples.length);
  const chroma = new Float64Array(12);
  for (let frame = 0; frame < plan.frameCount; frame += chunkFrames) {
    accumulate(samples, plan, chroma, frame, Math.min(frame + chunkFrames, plan.frameCount));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return bestKey(chroma);
}

/** Pentatonic note pool that stays compatible with most in-key chords. */
export function pentatonicPool(tonic, mode, loMidi = 55, hiMidi = 91) {
  const steps = mode === 'major' ? [0, 2, 4, 7, 9] : [0, 3, 5, 7, 10];
  const out = [];
  for (let m = loMidi; m <= hiMidi; m++) {
    if (steps.includes(((m - tonic) % 12 + 12) % 12)) out.push(m);
  }
  return out;
}

// In-place radix-2 FFT.
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
