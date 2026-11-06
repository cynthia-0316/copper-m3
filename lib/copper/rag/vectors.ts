// Gemini's embeddings are unit length only at their full size. At a reduced
// size (768 numbers) they have to be scaled to length 1 again; after that, the
// dot product of two vectors is their cosine similarity.

/** Scales a vector to length 1. */
export function normalize(vector: number[]): number[] {
  const length = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (!Number.isFinite(length) || length === 0) {
    throw new Error("Can't normalize an empty or invalid vector.");
  }
  return vector.map((x) => x / length);
}

/** The length of a vector. */
export function lengthOf(vector: number[]): number {
  return Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
}

/** Dot product: the cosine similarity of two normalized vectors. */
export function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error("Vectors differ in length.");
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
