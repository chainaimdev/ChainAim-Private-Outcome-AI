/**
 * The slice of Python's decimal.Decimal (default context: prec=28, ROUND_HALF_EVEN) and of float -> str that the dental
 * generator uses (Phase 4b-2), reproduced exactly. Sources (CPython v3.10.12, read verbatim; DESIGN/xrplh-25 §11):
 *   Lib/_pydecimal.py   DefaultContext(prec=28, rounding=ROUND_HALF_EVEN); __str__ (to-sci-string: plain when exp <= 0 and
 *                       leftdigits > -6); __neg__ (a zero negates to +0 unless rounding is FLOOR); __add__ (exponent =
 *                       min; zero + zero takes sign = min(signs); an exact zero sum is +0); __mul__ (sign xor, exponent
 *                       sum); quantize; __format__ ('f' rounds with the context rounding; ',' groups by 3).
 *   Objects/floatobject.c float_repr = PyOS_double_to_string(x, 'r', 0, Py_DTSF_ADD_DOT_0);
 *   Python/pystrtod.c     format_float_short mode 0: shortest round-trip digits; exponent when decpt <= -4 || decpt > 16,
 *                         written "%+.02d"; ".0" added to an integer in fixed notation.
 * Every operation here is exact. Where Python would round to 28 significant digits this module throws instead, so a result
 * can never silently differ from Python's.
 */

export const PREC = 28;
export type Rounding = "ROUND_HALF_UP" | "ROUND_HALF_EVEN";

const pow10 = (n: number): bigint => 10n ** BigInt(n);
const digitsOf = (c: bigint): number => (c === 0n ? 1 : c.toString().length);

export class Dec {
  /** sign 1 = negative (a zero keeps its sign, as in Python); coefficient >= 0; value = (-1)^sign * coeff * 10^exp. */
  readonly sign: 0 | 1;
  readonly coeff: bigint;
  readonly exp: number;

  private constructor(sign: 0 | 1, coeff: bigint, exp: number) {
    if (digitsOf(coeff) > PREC) throw new RangeError(`Dec: ${digitsOf(coeff)} significant digits exceed prec ${PREC}; Python would round here`);
    this.sign = sign; this.coeff = coeff; this.exp = exp;
  }

  static triple(sign: 0 | 1, coeff: bigint, exp: number): Dec { return new Dec(sign, coeff, exp); }

  /** Decimal(str): [sign] digits [. digits] [e [sign] digits]. Leading zeros are dropped from the coefficient, as Python does. */
  static of(v: string | number | bigint | Dec): Dec {
    if (v instanceof Dec) return v;
    if (typeof v === "bigint") return new Dec(v < 0n ? 1 : 0, v < 0n ? -v : v, 0);
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) throw new TypeError(`Dec.of(number) takes an int; for a float use Dec.of(pyFloatStr(x)), got ${v}`);
      return Dec.of(BigInt(v));
    }
    const m = /^\s*([+-])?(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?\s*$/.exec(v);
    if (!m) throw new SyntaxError(`Dec.of: invalid decimal literal ${JSON.stringify(v)}`);
    const intp = m[2] ?? "", frac = m[3] ?? m[4] ?? "";
    return new Dec(m[1] === "-" ? 1 : 0, BigInt((intp + frac) || "0"), (m[5] ? Number(m[5]) : 0) - frac.length);
  }

  isZero(): boolean { return this.coeff === 0n; }
  private signed(): bigint { return this.sign ? -this.coeff : this.coeff; }
  private aligned(e: number): bigint { return this.signed() * pow10(this.exp - e); }

  neg(): Dec { return this.isZero() ? new Dec(0, 0n, this.exp) : new Dec(this.sign ? 0 : 1, this.coeff, this.exp); }

  add(o: Dec): Dec {
    const e = Math.min(this.exp, o.exp);
    if (this.isZero() && o.isZero()) return new Dec(Math.min(this.sign, o.sign) as 0 | 1, 0n, e);
    const s = this.aligned(e) + o.aligned(e);
    return new Dec(s < 0n ? 1 : 0, s < 0n ? -s : s, e);
  }
  sub(o: Dec): Dec { return this.add(o.isZero() ? new Dec(o.sign ? 0 : 1, 0n, o.exp) : o.neg()); }
  mul(o: Dec): Dec { return new Dec((this.sign ^ o.sign) as 0 | 1, this.coeff * o.coeff, this.exp + o.exp); }

  /** Exact division (Python's result when the quotient terminates within prec digits, at the ideal exponent or as close as it can). */
  div(o: Dec): Dec {
    if (o.isZero()) throw new RangeError("Dec.div: division by zero");
    const ideal = this.exp - o.exp, sign = (this.sign ^ o.sign) as 0 | 1;
    if (this.isZero()) return new Dec(sign, 0n, ideal);
    for (let shift = 0; shift <= PREC + digitsOf(o.coeff); shift++) {
      const num = this.coeff * pow10(shift);
      if (num % o.coeff === 0n) {
        let q = num / o.coeff, e = ideal - shift;
        while (e < ideal && q % 10n === 0n) { q /= 10n; e++; }
        return new Dec(sign, q, e);
      }
    }
    throw new RangeError(`Dec.div: ${this.toString()}/${o.toString()} does not terminate within prec ${PREC}; Python would round here`);
  }

  cmp(o: Dec): -1 | 0 | 1 {
    const e = Math.min(this.exp, o.exp), a = this.aligned(e), b = o.aligned(e);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  /** A key equal for numerically equal values (Python: Decimal('1.0') == Decimal('1.00'), and they hash alike). */
  key(): string {
    if (this.isZero()) return "0";
    let c = this.coeff, e = this.exp;
    while (c % 10n === 0n) { c /= 10n; e++; }
    return `${this.sign ? "-" : ""}${c}e${e}`;
  }
  lt(o: Dec): boolean { return this.cmp(o) < 0; }
  gt(o: Dec): boolean { return this.cmp(o) > 0; }
  eq(o: Dec): boolean { return this.cmp(o) === 0; }

  /** quantize(Decimal('1e<exp>'), rounding): the sign is kept, a zero included. */
  quantize(exp: number, rounding: Rounding): Dec {
    if (exp <= this.exp) return new Dec(this.sign, this.coeff * pow10(this.exp - exp), exp);
    const d = pow10(exp - this.exp);
    let q = this.coeff / d;
    const r2 = (this.coeff % d) * 2n;
    if (r2 > d || (r2 === d && (rounding === "ROUND_HALF_UP" || q % 2n === 1n))) q += 1n;
    return new Dec(this.sign, q, exp);
  }

  /** int(Decimal): truncates toward zero. */
  toBigInt(): bigint {
    const v = this.exp >= 0 ? this.coeff * pow10(this.exp) : this.coeff / pow10(-this.exp);
    return this.sign ? -v : v;
  }
  /** float(Decimal): the correctly rounded double of the decimal string (JS Number() of a decimal string is correctly rounded). */
  toNumber(): number { return Number(this.toString()); }

  /** str(Decimal), _pydecimal.__str__ with eng=False and capitals=1. */
  toString(): string {
    const int = this.coeff.toString(), leftdigits = this.exp + int.length;
    const dotplace = this.exp <= 0 && leftdigits > -6 ? leftdigits : 1;
    let intpart: string, fracpart: string;
    if (dotplace <= 0) { intpart = "0"; fracpart = "." + "0".repeat(-dotplace) + int; }
    else if (dotplace >= int.length) { intpart = int + "0".repeat(dotplace - int.length); fracpart = ""; }
    else { intpart = int.slice(0, dotplace); fracpart = "." + int.slice(dotplace); }
    const e = leftdigits === dotplace ? "" : "E" + (leftdigits - dotplace >= 0 ? "+" : "") + (leftdigits - dotplace);
    return (this.sign ? "-" : "") + intpart + fracpart + e;
  }

  /** format(d, ".<p>f") or format(d, ",.<p>f"): rounds with the context rounding (ROUND_HALF_EVEN); the sign of a zero is shown. */
  format(places: number, grouping = false): string {
    const q = this.quantize(-places, "ROUND_HALF_EVEN");
    const s = q.coeff.toString().padStart(places + 1, "0");
    let intpart = s.slice(0, s.length - places);
    const frac = s.slice(s.length - places);
    if (grouping) intpart = intpart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return (q.sign ? "-" : "") + intpart + (places ? "." + frac : "");
  }
}

/** str(float) / repr(float) in CPython: shortest round-trip digits, Python's fixed/exponent thresholds and ".0" rule. */
export function pyFloatStr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (!Number.isFinite(x)) return x > 0 ? "inf" : "-inf";
  const neg = x < 0 || Object.is(x, -0);
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(Math.abs(x).toExponential());
  if (!m) throw new Error(`pyFloatStr: unexpected toExponential output for ${x}`);
  const digits = m[1] + (m[2] ?? ""), decpt = Number(m[3]) + 1;
  let body: string;
  if (decpt <= -4 || decpt > 16) {
    const e = decpt - 1;
    body = digits[0] + (digits.length > 1 ? "." + digits.slice(1) : "") + "e" + (e < 0 ? "-" : "+") + String(Math.abs(e)).padStart(2, "0");
  } else if (decpt <= 0) body = "0." + "0".repeat(-decpt) + digits;
  else if (decpt >= digits.length) body = digits + "0".repeat(decpt - digits.length) + ".0";
  else body = digits.slice(0, decpt) + "." + digits.slice(decpt);
  return (neg ? "-" : "") + body;
}

/** Decimal(str(x)) for a Python float x. */
export const decFromFloat = (x: number): Dec => Dec.of(pyFloatStr(x));
