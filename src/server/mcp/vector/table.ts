import { readFileSync } from 'node:fs';
import { pieces } from './wordpiece.ts';

/**
 * The vendored embedding table, and turning a text into a direction with it.
 *
 * What makes this shippable at all is that the model has no layers. A
 * distilled static embedding — Model2Vec's construction — is a sentence
 * transformer's knowledge collapsed into one row per token, so encoding is a
 * lookup and an average rather than a forward pass. There is no runtime to
 * install, no tensor library, no accelerator, and nothing to download at
 * startup: the whole model is this file, and reading it is reading a file.
 *
 * That is the property the endpoint needs. A Cloud Run instance is created to
 * serve one request and may be replaced before the next (ADR-002), so anything
 * that costs seconds at startup costs them on a request somebody is waiting
 * for, and anything that needs the network at startup can fail there.
 *
 * The file is one file for the same reason: a second file is a second thing
 * that can be missing from a published tarball, and it would go missing in the
 * one environment nobody runs before publishing.
 */

/** What one loaded table is: a vocabulary, and a row of numbers per entry. */
export interface Table {
  readonly dims: number;
  readonly vocabulary: ReadonlyMap<string, number>;
  /** Quantised rows, `rows * dims` of them, each to be multiplied by its scale. */
  readonly weights: Int8Array;
  readonly scales: Float32Array;
}

const MAGIC = 'LVEC';

/**
 * Read the table.
 *
 * Int8 with one scale per row, which is the whole of the compression story.
 * Full precision is four times the size and measurably no better here: the
 * quantisation error on a single row is far below the distance between two
 * capabilities' descriptions, and the averaging that follows shrinks it
 * further. Per row rather than one scale for the table, because a rare token's
 * row is much smaller than a common one's and a single scale would round the
 * rare ones to zero — which is to say, would delete exactly the tokens that
 * carry the most information.
 */
export function readTable(path: string): Table {
  const bytes = readFileSync(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const magic = new TextDecoder().decode(bytes.subarray(0, 4));
  if (magic !== MAGIC) throw new Error(`not an embedding table: ${path}`);

  const headerLength = view.getUint32(4, true);
  let at = 8;
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(at, at + headerLength))) as {
    dims: number;
    rows: number;
    vocabBytes: number;
  };
  at += headerLength;

  const vocabulary = new Map<string, number>();
  const tokens = new TextDecoder().decode(bytes.subarray(at, at + header.vocabBytes)).split('\n');
  for (let row = 0; row < tokens.length; row++) vocabulary.set(tokens[row] as string, row);
  at += header.vocabBytes;

  // Copied rather than viewed. A `Buffer` from `readFileSync` may sit at any
  // offset inside a pooled allocation, and a typed array wants its own aligned
  // backing store — a view onto an odd offset throws, and only for some files.
  const scales = new Float32Array(header.rows);
  for (let row = 0; row < header.rows; row++) scales[row] = view.getFloat32(at + row * 4, true);
  at += header.rows * 4;

  const weights = new Int8Array(header.rows * header.dims);
  weights.set(new Int8Array(bytes.buffer, bytes.byteOffset + at, weights.length));

  return { dims: header.dims, vocabulary, weights, scales };
}

/**
 * A text as a unit vector, or `undefined` if it had nothing to say.
 *
 * The mean of the rows its tokens address, normalised — which is the whole of
 * Model2Vec's inference, and is the same operation the distillation was fitted
 * against. Zipf weighting, the part that stops *the* and *of* dominating an
 * average, was applied when the table was built and is already in the rows; a
 * second weighting here would apply it twice.
 *
 * Normalising is what makes the comparison a cosine and a dot product the same
 * thing, so the search below is a multiply-and-add with nothing else in it.
 *
 * `undefined` rather than a zero vector for a text with no known tokens,
 * because a zero vector has a cosine of zero with everything and would read as
 * a real and uniformly poor score rather than as an absence.
 */
export function embed(text: string, table: Table): Float32Array | undefined {
  const rows = pieces(text, table.vocabulary);
  if (rows.length === 0) return undefined;

  const vector = new Float32Array(table.dims);
  for (const row of rows) {
    const scale = table.scales[row] as number;
    const base = row * table.dims;
    for (let d = 0; d < table.dims; d++) vector[d] = (vector[d] as number) + (table.weights[base + d] as number) * scale;
  }

  let magnitude = 0;
  for (let d = 0; d < table.dims; d++) magnitude += (vector[d] as number) ** 2;
  magnitude = Math.sqrt(magnitude);
  if (magnitude === 0) return undefined;

  for (let d = 0; d < table.dims; d++) vector[d] = (vector[d] as number) / magnitude;
  return vector;
}

/** Cosine, given both sides are already unit vectors. */
export function similarity(a: Float32Array, b: Float32Array): number {
  let total = 0;
  for (let d = 0; d < a.length; d++) total += (a[d] as number) * (b[d] as number);
  return total;
}
