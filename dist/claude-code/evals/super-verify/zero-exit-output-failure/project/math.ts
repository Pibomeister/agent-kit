export const add = (a: number, b: number): number => a + b;
export const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, n);
export const mean = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / (xs.length - 1);
