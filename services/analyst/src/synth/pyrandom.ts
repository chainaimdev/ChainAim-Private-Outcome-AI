/**
 * CPython's random.Random, reproduced exactly for the calls the dental generator makes (Phase 4b-2), so a TypeScript port
 * of tools/dental-synth/gen_dental_set.py writes the same bytes as the Python script for the same seed.
 *
 * Sources (CPython v3.10.12, read verbatim; DESIGN/xrplh-25 §11):
 *   Modules/_randommodule.c  genrand_uint32, init_genrand, init_by_array, random_seed (int: abs value, 32-bit words from the
 *                            right, little-endian), _random_Random_random_impl (res53), _random_Random_getrandbits_impl.
 *   Lib/random.py            _randbelow_with_getrandbits, randrange, randint, choice, shuffle, choices, uniform.
 * Only integer seeds are supported (the generator never seeds with None, str or bytes); anything else is refused, not hashed.
 * Proof: services/analyst/test/pyrandom.test.ts (golden vectors produced by Python 3.10.12) and tools/dental-synth/compare_port.py.
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export class PyRandom {
  private mt = new Uint32Array(N);
  private index = N + 1;

  constructor(seed: number | bigint) {
    this.seed(seed);
  }

  /** random_seed for an int argument: n = abs(seed); key = n split into 32-bit words from the right; init_by_array(key). */
  seed(seed: number | bigint): void {
    if (typeof seed === "number" && !Number.isSafeInteger(seed)) throw new TypeError(`PyRandom: seed must be an integer, got ${seed}`);
    let n = BigInt(seed);
    if (n < 0n) n = -n;
    const bits = n === 0n ? 0 : n.toString(2).length;
    const keyused = bits === 0 ? 1 : Math.floor((bits - 1) / 32) + 1;
    const key = new Uint32Array(keyused);
    for (let i = 0; i < keyused; i++) key[i] = Number((n >> BigInt(32 * i)) & 0xffffffffn);
    this.initByArray(key);
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    let mti = 1;
    for (; mti < N; mti++) mt[mti] = (Math.imul(1812433253, mt[mti - 1] ^ (mt[mti - 1] >>> 30)) + mti) >>> 0;
    this.index = mti;
  }

  private initByArray(key: Uint32Array): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1, j = 0;
    for (let k = N > key.length ? N : key.length; k; k--) {
      mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) + key[j] + j) >>> 0;
      i++; j++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k; k--) {
      mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
    }
    mt[0] = 0x80000000;
  }

  /** genrand_uint32: a uint32 from MT19937, with the reference tempering. */
  genrandUint32(): number {
    const mt = this.mt;
    let y: number;
    if (this.index >= N) {
      let kk = 0;
      for (; kk < N - M; kk++) {
        y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + M] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk] & UPPER_MASK) | (mt[kk + 1] & LOWER_MASK);
        mt[kk] = mt[kk + (M - N)] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      y = (mt[N - 1] & UPPER_MASK) | (mt[0] & LOWER_MASK);
      mt[N - 1] = mt[M - 1] ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      this.index = 0;
    }
    y = mt[this.index++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** random(): (a*67108864.0+b)*(1.0/9007199254740992.0) with a = 27 bits, b = 26 bits; every step is exact in a double. */
  random(): number {
    const a = this.genrandUint32() >>> 5, b = this.genrandUint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  /** getrandbits(k): k <= 32 is one word >> (32 - k); more fills 32-bit words from the least significant, the top one shifted. */
  getrandbits(k: number): bigint {
    if (!Number.isInteger(k) || k < 0) throw new RangeError("number of bits must be non-negative");
    if (k === 0) return 0n;
    if (k <= 32) return BigInt(this.genrandUint32() >>> (32 - k));
    let out = 0n;
    for (let i = 0, left = k; left > 0; i++, left -= 32) {
      let r = this.genrandUint32();
      if (left < 32) r >>>= 32 - left;
      out |= BigInt(r) << BigInt(32 * i);
    }
    return out;
  }

  /** _randbelow_with_getrandbits(n): k = n.bit_length(); draw getrandbits(k) until it is below n. */
  randbelow(n: number): number {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`randbelow: n must be a non-negative safe integer, got ${n}`);
    if (n === 0) return 0;
    const k = n.toString(2).length, bn = BigInt(n);
    let r = this.getrandbits(k);
    while (r >= bn) r = this.getrandbits(k);
    return Number(r);
  }

  /** randrange(start[, stop[, step]]) for integer arguments (the 3.10 float-argument deprecation path is not supported). */
  randrange(start: number, stop?: number, step = 1): number {
    for (const v of [start, stop ?? 0, step]) if (!Number.isSafeInteger(v)) throw new TypeError(`randrange: integer arguments only, got ${v}`);
    if (stop === undefined) {
      if (step !== 1) throw new TypeError("Missing a non-None stop argument");
      if (start > 0) return this.randbelow(start);
      throw new RangeError("empty range for randrange()");
    }
    const width = stop - start;
    if (step === 1) {
      if (width > 0) return start + this.randbelow(width);
      throw new RangeError(`empty range for randrange() (${start}, ${stop}, ${width})`);
    }
    let n: number;
    if (step > 0) n = Math.floor((width + step - 1) / step);
    else if (step < 0) n = Math.floor((width + step + 1) / step);
    else throw new RangeError("zero step for randrange()");
    if (n <= 0) throw new RangeError("empty range for randrange()");
    return start + step * this.randbelow(n);
  }

  randint(a: number, b: number): number {
    return this.randrange(a, b + 1);
  }

  choice<T>(seq: readonly T[]): T {
    if (seq.length === 0) throw new RangeError("Cannot choose from an empty sequence");
    return seq[this.randbelow(seq.length)];
  }

  /** shuffle(x) in place: for i in reversed(range(1, len(x))): j = _randbelow(i + 1); swap. */
  shuffle<T>(x: T[]): void {
    for (let i = x.length - 1; i >= 1; i--) {
      const j = this.randbelow(i + 1);
      const t = x[i]; x[i] = x[j]; x[j] = t;
    }
  }

  /** choices(population, weights, k): cum_weights = accumulate(weights); total = cum[-1] + 0.0; bisect_right(cum, random()*total, 0, n-1). */
  choices<T>(population: readonly T[], weights?: readonly number[], k = 1): T[] {
    const n = population.length;
    if (weights === undefined) return Array.from({ length: k }, () => population[Math.floor(this.random() * n)]);
    if (weights.length !== n) throw new RangeError("The number of weights does not match the population");
    const cum: number[] = [];
    let acc = 0;
    for (const w of weights) { acc += w; cum.push(acc); }
    const total = cum[n - 1] + 0.0;
    if (!(total > 0.0)) throw new RangeError("Total of weights must be greater than zero");
    if (!Number.isFinite(total)) throw new RangeError("Total of weights must be finite");
    const out: T[] = [];
    for (let i = 0; i < k; i++) out.push(population[bisectRight(cum, this.random() * total, 0, n - 1)]);
    return out;
  }

  /** uniform(a, b) = a + (b - a) * random(). */
  uniform(a: number, b: number): number {
    return a + (b - a) * this.random();
  }
}

/** bisect.bisect_right(a, x, lo, hi). */
export function bisectRight(a: readonly number[], x: number, lo: number, hi: number): number {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (x < a[mid]) hi = mid; else lo = mid + 1;
  }
  return lo;
}
