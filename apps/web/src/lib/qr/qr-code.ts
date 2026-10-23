/**
 * Dependency-free QR Code encoder (ISO/IEC 18004), byte mode only.
 *
 * Used to print a scannable pay link on customer invoices (PDF, drawer, pay page).
 * A port of the well-known Project Nayuki reference algorithm, trimmed to what the
 * pay link needs: UTF-8 byte mode, versions 1–40, all four ECC levels, automatic
 * smallest-version selection and automatic mask selection by the standard penalty
 * rules (or a forced mask). Deterministic: the same text + options always yields the
 * same matrix. Verified bit-for-bit against the python `qrcode` reference.
 */

export type QrEcc = 'L' | 'M' | 'Q' | 'H';

export interface QrMatrix {
  /** Modules per side (21 for version 1, +4 per version). */
  size: number;
  /** modules[y][x]; true = dark. */
  modules: boolean[][];
}

export interface QrOptions {
  ecc?: QrEcc;
  minVersion?: number;
  maxVersion?: number;
  /** Force a mask 0–7 (default: lowest penalty). */
  mask?: number;
}

/** Format-info bits per ECC level (ISO order: M=0, L=1, H=2, Q=3). */
const ECC_FORMAT_BITS: Record<QrEcc, number> = { L: 1, M: 0, Q: 3, H: 2 };
const ECC_ORDINAL: Record<QrEcc, number> = { L: 0, M: 1, Q: 2, H: 3 };

// Per version (index 1..40): EC codewords per block and number of blocks, per ECC (L,M,Q,H).
const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Raw data modules available in a version (after function patterns), in bits. */
function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

/** Data codewords (bytes) a version/ECC combination can carry. */
function numDataCodewords(ver: number, ecc: QrEcc): number {
  const e = ECC_ORDINAL[ecc];
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e][ver] * NUM_ERROR_CORRECTION_BLOCKS[e][ver];
}

// ── Reed–Solomon over GF(2^8), primitive polynomial 0x11D ─────────────────────
function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result: number[] = new Array<number>(degree - 1).fill(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

/** Split data into blocks, append EC per block, interleave. */
function addEccAndInterleave(data: number[], ver: number, ecc: QrEcc): number[] {
  const e = ECC_ORDINAL[ecc];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e][ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e][ver];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  const divisor = rsDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const eccBytes = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0); // placeholder so all blocks align; skipped below
    blocks.push(dat.concat(eccBytes));
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

// ── Bit buffer ───────────────────────────────────────────────────────────────
function appendBits(val: number, len: number, bb: number[]): void {
  for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
}

/** Byte-mode segment → padded data codewords for this version. */
function buildDataCodewords(bytes: Uint8Array, ver: number, ecc: QrEcc): number[] {
  const bb: number[] = [];
  appendBits(0x4, 4, bb); // byte mode
  appendBits(bytes.length, ver <= 9 ? 8 : 16, bb);
  for (const b of bytes) appendBits(b, 8, bb);
  const capacityBits = numDataCodewords(ver, ecc) * 8;
  appendBits(0, Math.min(4, capacityBits - bb.length), bb); // terminator
  appendBits(0, (8 - (bb.length % 8)) % 8, bb); // byte align
  for (let pad = 0xec; bb.length < capacityBits; pad ^= 0xec ^ 0x11) appendBits(pad, 8, bb);
  const out: number[] = new Array<number>(bb.length / 8).fill(0);
  bb.forEach((bit, i) => { out[i >>> 3] |= bit << (7 - (i & 7)); });
  return out;
}

// ── Matrix construction ──────────────────────────────────────────────────────
class Grid {
  readonly size: number;
  readonly modules: boolean[][];
  readonly isFunction: boolean[][];

  constructor(readonly version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  alignmentPositions(): number[] {
    if (this.version === 1) return [];
    const numAlign = Math.floor(this.version / 7) + 2;
    const step = Math.floor((this.version * 8 + numAlign * 3 + 5) / (numAlign * 4 - 4)) * 2;
    const result = [6];
    for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFunction(6, i, i % 2 === 0); // timing
      this.setFunction(i, 6, i % 2 === 0);
    }
    this.drawFinder(3, 3);
    this.drawFinder(this.size - 4, 3);
    this.drawFinder(3, this.size - 4);
    const pos = this.alignmentPositions();
    const n = pos.length;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        // Skip the three finder corners.
        if (!((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0))) {
          this.drawAlignment(pos[i], pos[j]);
        }
      }
    }
    this.drawFormatBits('L', 0); // placeholder, overwritten after masking
    this.drawVersion();
  }

  drawFinder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFunction(xx, yy, dist !== 2 && dist !== 4);
      }
    }
  }

  drawAlignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }

  drawFormatBits(ecc: QrEcc, mask: number): void {
    const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.setFunction(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.setFunction(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.setFunction(8, this.size - 15 + i, bit(i));
    this.setFunction(8, this.size - 8, true); // the dark module
  }

  drawVersion(): void {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = this.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunction(a, b, dark);
      this.setFunction(b, a, dark);
    }
  }

  /** Zig-zag placement of the codeword bits into the non-function modules. */
  drawCodewords(codewords: readonly number[]): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < codewords.length * 8) {
            this.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }
  }

  /** XOR a mask pattern over the data modules (self-inverse). */
  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        }
        if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  /** ISO penalty score (rules N1–N4); lower is better. */
  penalty(): number {
    const n = this.size;
    let result = 0;
    const lineScore = (get: (a: number, b: number) => boolean) => {
      for (let a = 0; a < n; a++) {
        let runColor = false;
        let runLen = 0;
        const history = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < n; b++) {
          if (get(a, b) === runColor) {
            runLen++;
            if (runLen === 5) result += 3;
            else if (runLen > 5) result++;
          } else {
            this.finderPenaltyAddHistory(runLen, history);
            if (!runColor) result += this.finderPenaltyCountPatterns(history) * 40;
            runColor = get(a, b);
            runLen = 1;
          }
        }
        result += this.finderPenaltyTerminateAndCount(runColor, runLen, history) * 40;
      }
    };
    lineScore((y, x) => this.modules[y][x]);
    lineScore((x, y) => this.modules[y][x]);
    for (let y = 0; y < n - 1; y++) {
      for (let x = 0; x < n - 1; x++) {
        const c = this.modules[y][x];
        if (c === this.modules[y][x + 1] && c === this.modules[y + 1][x] && c === this.modules[y + 1][x + 1]) result += 3;
      }
    }
    let dark = 0;
    for (const row of this.modules) for (const m of row) if (m) dark++;
    const total = n * n;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  }

  private finderPenaltyCountPatterns(h: number[]): number {
    const m = h[1];
    const core = m > 0 && h[2] === m && h[3] === m * 3 && h[4] === m && h[5] === m;
    return (core && h[0] >= m * 4 && h[6] >= m ? 1 : 0) + (core && h[6] >= m * 4 && h[0] >= m ? 1 : 0);
  }

  private finderPenaltyTerminateAndCount(runColor: boolean, runLen: number, h: number[]): number {
    let len = runLen;
    if (runColor) {
      this.finderPenaltyAddHistory(len, h);
      len = 0;
    }
    len += this.size;
    this.finderPenaltyAddHistory(len, h);
    return this.finderPenaltyCountPatterns(h);
  }

  private finderPenaltyAddHistory(runLen: number, h: number[]): void {
    let len = runLen;
    if (h[0] === 0) len += this.size; // light border before the first run
    h.pop();
    h.unshift(len);
  }
}

/** Encode `text` (UTF-8, byte mode) as a QR matrix. */
export function encodeQr(text: string, opts: QrOptions = {}): QrMatrix {
  const ecc: QrEcc = opts.ecc ?? 'M';
  const minVersion = opts.minVersion ?? 1;
  const maxVersion = opts.maxVersion ?? 40;
  if (!(minVersion >= 1 && maxVersion <= 40 && minVersion <= maxVersion)) throw new Error('Invalid QR version range');
  if (opts.mask !== undefined && !(Number.isInteger(opts.mask) && opts.mask >= 0 && opts.mask <= 7)) {
    throw new Error('QR mask must be an integer 0–7');
  }
  const bytes = new TextEncoder().encode(text);

  let version = -1;
  for (let v = minVersion; v <= maxVersion; v++) {
    const needBits = 4 + (v <= 9 ? 8 : 16) + bytes.length * 8;
    if ((v <= 9 ? bytes.length < 256 : bytes.length < 65536) && needBits <= numDataCodewords(v, ecc) * 8) {
      version = v;
      break;
    }
  }
  if (version < 0) throw new Error(`Text too long for a QR code (${bytes.length} bytes at ECC ${ecc}, version ≤ ${maxVersion})`);

  const codewords = addEccAndInterleave(buildDataCodewords(bytes, version, ecc), version, ecc);
  const grid = new Grid(version);
  grid.drawFunctionPatterns();
  grid.drawCodewords(codewords);

  let mask = opts.mask ?? -1;
  if (mask < 0) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      grid.applyMask(m);
      grid.drawFormatBits(ecc, m);
      const p = grid.penalty();
      if (p < best) {
        best = p;
        mask = m;
      }
      grid.applyMask(m); // undo
    }
  }
  grid.applyMask(mask);
  grid.drawFormatBits(ecc, mask);
  return { size: grid.size, modules: grid.modules.map((row) => row.slice()) };
}

/**
 * An SVG path of the dark modules (horizontal runs merged), offset by a quiet zone.
 * Render as <svg viewBox="0 0 {viewBox} {viewBox}"><path d={d} fill="…"/></svg>.
 */
export function qrSvgPath(m: QrMatrix, opts: { quiet?: number } = {}): { viewBox: number; d: string } {
  const quiet = opts.quiet ?? 4;
  const parts: string[] = [];
  for (let y = 0; y < m.size; y++) {
    let x = 0;
    while (x < m.size) {
      if (!m.modules[y][x]) { x++; continue; }
      const start = x;
      while (x < m.size && m.modules[y][x]) x++;
      parts.push(`M${start + quiet},${y + quiet}h${x - start}v1h-${x - start}z`);
    }
  }
  return { viewBox: m.size + quiet * 2, d: parts.join('') };
}
