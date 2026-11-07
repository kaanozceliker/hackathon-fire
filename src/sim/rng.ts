/** Deterministic hashing / noise helpers. Same inputs always give the same outputs. */

export function hash3(seed: number, a: number, b: number): number {
  let h = (seed ^ Math.imul(a, 0x85ebca6b) ^ Math.imul(b, 0xc2b2ae35)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d)
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}

function smooth(t: number) {
  return t * t * (3 - 2 * t)
}

export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = smooth(x - xi)
  const yf = smooth(y - yi)
  const a = hash3(seed, xi, yi)
  const b = hash3(seed, xi + 1, yi)
  const c = hash3(seed, xi, yi + 1)
  const d = hash3(seed, xi + 1, yi + 1)
  return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf
}

export function fbm(x: number, y: number, seed: number, octaves = 4): number {
  let amp = 0.5
  let freq = 1
  let sum = 0
  let norm = 0
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 101)
    norm += amp
    amp *= 0.5
    freq *= 2
  }
  return sum / norm
}

export function strSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}
