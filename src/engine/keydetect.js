/**
 * 从音频估计调性，用于「只有 MP3、没有配套 MIDI」的情况。
 *
 * 做法是标准的 Krumhansl 调性轮廓匹配：
 * 音频 -> 色度向量(12 维，每个半音的能量) -> 和 24 个大小调模板求相关 -> 取最高分。
 * 只分析前 60 秒，足够定调，也不至于把内存吃爆。
 */

// Krumhansl-Schmuckler 调性轮廓
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function corr(a, b) {
  const n = a.length;
  const ma = a.reduce((x, y) => x + y) / n, mb = b.reduce((x, y) => x + y) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** @param buffer AudioBuffer @returns {{tonic:number, mode:'major'|'minor', name:string, confidence:number}} */
export function detectKey(buffer) {
  const sr = buffer.sampleRate;
  const mono = buffer.getChannelData(0);
  const maxSamples = Math.min(mono.length, sr * 60);

  const FFT = 4096;
  const HOP = 2048;
  const chroma = new Float64Array(12);

  // 预算每个 FFT bin 对应的半音号
  const binPc = new Int8Array(FFT / 2);
  for (let k = 1; k < FFT / 2; k++) {
    const f = (k * sr) / FFT;
    binPc[k] = (f >= 55 && f <= 2200)
      ? ((Math.round(12 * Math.log2(f / 440)) % 12) + 12 + 9) % 12   // A4=440 -> pc 9
      : -1;
  }

  const win = new Float64Array(FFT);
  for (let i = 0; i < FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT - 1));

  const re = new Float64Array(FFT), im = new Float64Array(FFT);
  for (let pos = 0; pos + FFT < maxSamples; pos += HOP) {
    for (let i = 0; i < FFT; i++) { re[i] = mono[pos + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 1; k < FFT / 2; k++) {
      const pc = binPc[k];
      if (pc < 0) continue;
      chroma[pc] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }
  }

  const total = chroma.reduce((a, b) => a + b) || 1;
  const norm = [...chroma].map((v) => v / total);

  let best = { score: -2 };
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, profile] of [['major', MAJOR], ['minor', MINOR]]) {
      const rotated = profile.map((_, i) => profile[(i - tonic + 12) % 12]);
      const score = corr(norm, rotated);
      if (score > best.score) best = { score, tonic, mode };
    }
  }
  return {
    tonic: best.tonic, mode: best.mode,
    name: `${NAMES[best.tonic]} ${best.mode === 'major' ? 'major' : 'minor'}`,
    confidence: +Math.max(0, best.score).toFixed(2),
  };
}

/** 五声音阶音池：在调内几乎不会和任何和弦冲突，这是「怎么按都不难听」的关键 */
export function pentatonicPool(tonic, mode, loMidi = 55, hiMidi = 91) {
  const steps = mode === 'major' ? [0, 2, 4, 7, 9] : [0, 3, 5, 7, 10];
  const out = [];
  for (let m = loMidi; m <= hiMidi; m++) {
    if (steps.includes(((m - tonic) % 12 + 12) % 12)) out.push(m);
  }
  return out;
}

// 原地基 2 FFT
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
