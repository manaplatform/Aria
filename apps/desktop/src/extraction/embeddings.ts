import { Tokenizer } from '@huggingface/tokenizers';
import { env, InferenceSession, Tensor } from 'onnxruntime-web/wasm';
import wasm from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

env.wasm.numThreads = 1;
env.wasm.wasmPaths = { wasm: new URL(wasm, location.href).href };

const origin = 'aria-embedding-pack://bundle/';
const files = Promise.all([
  fetch(origin + 'tokenizer.json').then((response) => response.json()),
  fetch(origin + 'tokenizer_config.json').then((response) => response.json()),
  fetch(origin + 'model_quantized.onnx').then((response) => response.arrayBuffer()),
]);
const ready = files.then(async ([configuration, special, model]) => ({
  tokenizer: new Tokenizer(configuration, special),
  session: await InferenceSession.create(model, { executionProviders: ['wasm'] }),
}));

export async function embed(texts: string[]) {
  const { tokenizer, session } = await ready;
  const vectors: number[][] = [];
  for (const text of texts) {
    const encoded = tokenizer.encode(text);
    const ids =
      encoded.ids.length > 128 ? [...encoded.ids.slice(0, 127), encoded.ids.at(-1)!] : encoded.ids;
    if (!ids.length) throw new Error('The text could not be tokenized.');
    const dims = [1, ids.length];
    const inputs: Record<string, Tensor> = {
      input_ids: new Tensor('int64', BigInt64Array.from(ids, BigInt), dims),
      attention_mask: new Tensor('int64', new BigInt64Array(ids.length).fill(1n), dims),
    };
    if (session.inputNames.includes('token_type_ids'))
      inputs.token_type_ids = new Tensor('int64', new BigInt64Array(ids.length), dims);
    const outputs = await session.run(inputs);
    const hidden = outputs.last_hidden_state;
    if (hidden?.type !== 'float32' || hidden.dims.at(-1) !== 384 || hidden.dims[1] !== ids.length)
      throw new Error('The embedding model returned an unexpected representation.');
    const vector = Array<number>(384).fill(0);
    for (let i = 0; i < hidden.data.length; i++) vector[i % 384] += Number(hidden.data[i]);
    const norm = Math.hypot(...vector);
    if (!Number.isFinite(norm) || norm === 0)
      throw new Error('The embedding model returned an invalid vector.');
    vectors.push(vector.map((value) => value / norm));
  }
  return vectors;
}
