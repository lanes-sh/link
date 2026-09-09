/**
 * Build `src/server/mcp/vector/table.lvec` from a published Model2Vec checkpoint.
 *
 * The counterpart of `vendor:google`: a data change, run deliberately, with the
 * result committed. The alternative — downloading at install or at startup —
 * puts a network call on the path of an endpoint whose whole design is that an
 * instance may be created and replaced between two requests (ADR-002).
 *
 *     bun run vendor:vectors                          # the shipped table
 *     bun run vendor:vectors <model> [keep]           # another, or a pruned one
 *
 * `minishlab/potion-base-4M` is what ships, chosen by measurement rather than
 * by size: `bench/compare.ts` puts it ahead of the 8M and 32M checkpoints on
 * this corpus at a half and an eighth of their bytes. Bigger is not better here
 * because the corpus is short identifiers and one-sentence descriptions, which
 * is not what a larger table's extra capacity was distilled for.
 *
 * Layout, in order: magic, a JSON header, the vocabulary, one float32 scale per
 * row, then the int8 matrix. One file, because a second file is a second thing
 * that can be missing from a published tarball — and it would go missing in the
 * one environment nobody runs before publishing.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MODEL = process.argv[2] ?? 'minishlab/potion-base-4M';
const KEEP = Number(process.argv[3] ?? 0);
const OUT = new URL('../src/server/mcp/vector/table.lvec', import.meta.url).pathname;

async function fetchTo(path: string, url: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
}

const scratch = mkdtempSync(join(tmpdir(), 'lanes-vectors-'));
const base = `https://huggingface.co/${MODEL}/resolve/main`;
console.error(`fetching ${MODEL}`);
await fetchTo(join(scratch, 'model.safetensors'), `${base}/model.safetensors`);
await fetchTo(join(scratch, 'tokenizer.json'), `${base}/tokenizer.json`);

const raw = new Uint8Array(readFileSync(join(scratch, 'model.safetensors')));
const headerLen = Number(new DataView(raw.buffer, raw.byteOffset, 8).getBigUint64(0, true));
const meta = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + headerLen)));
const spec = meta.embeddings;
const [rows, dims] = spec.shape as [number, number];
const floats = new Float32Array(
  raw.buffer.slice(raw.byteOffset + 8 + headerLen + spec.data_offsets[0], raw.byteOffset + 8 + headerLen + spec.data_offsets[1]),
);

const tokenizer = JSON.parse(readFileSync(join(scratch, 'tokenizer.json'), 'utf8'));
const vocabMap = tokenizer.model.vocab as Record<string, number>;
const tokens: string[] = new Array(rows).fill('');
for (const [token, index] of Object.entries(vocabMap)) if (index < rows) tokens[index] = token;

// Which rows survive, if the table is pruned. Every single character and every
// continuation piece stays, because they are what an unknown word decomposes
// into — dropping them turns a rare word into [UNK] rather than into subwords.
let order: number[] = Array.from({ length: rows }, (_, i) => i);
if (KEEP > 0 && KEEP < rows) {
  const essential = new Set<number>();
  for (let i = 0; i < rows; i++) {
    const t = tokens[i]!;
    if (t.startsWith('[') || t.startsWith('##') || [...t].length <= 2) essential.add(i);
  }
  const rest = order.filter((i) => !essential.has(i)).slice(0, Math.max(0, KEEP - essential.size));
  order = [...essential, ...rest].sort((a, b) => a - b);
}

const kept = order.length;
const scales = new Float32Array(kept);
const quantized = new Int8Array(kept * dims);
for (let r = 0; r < kept; r++) {
  const src = order[r]! * dims;
  let max = 0;
  for (let d = 0; d < dims; d++) max = Math.max(max, Math.abs(floats[src + d]!));
  const scale = max === 0 ? 1 : max / 127;
  scales[r] = scale;
  for (let d = 0; d < dims; d++) quantized[r * dims + d] = Math.max(-127, Math.min(127, Math.round(floats[src + d]! / scale)));
}

const vocabBlob = new TextEncoder().encode(order.map((i) => tokens[i]).join('\n'));
const header = new TextEncoder().encode(
  JSON.stringify({ version: 1, dims, rows: kept, vocabBytes: vocabBlob.length, source: MODEL }),
);
const out = new Uint8Array(4 + 4 + header.length + vocabBlob.length + kept * 4 + kept * dims);
let at = 0;
out.set(new TextEncoder().encode('LVEC'), at); at += 4;
new DataView(out.buffer).setUint32(at, header.length, true); at += 4;
out.set(header, at); at += header.length;
out.set(vocabBlob, at); at += vocabBlob.length;
out.set(new Uint8Array(scales.buffer), at); at += kept * 4;
out.set(new Uint8Array(quantized.buffer, quantized.byteOffset, quantized.length), at);

writeFileSync(OUT, out);
console.log(`${OUT}  ${kept} rows x ${dims} dims  ${(out.length / 1024 / 1024).toFixed(2)} MB`);
