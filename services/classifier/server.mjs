#!/usr/bin/env node
// Prompt-injection classifier service. Runs Llama Prompt Guard 2 locally through ONNX and
// answers with a risk score; the gateway's "Prompt injection classifier" block calls it.
//
//   npm install && npm start                      http://localhost:3333
//   node server.mjs --port 3400 --dtype q8        smaller, less accurate weights
//
//   POST /classify  {"text": "..."} or {"texts": ["...", "..."]}
//     -> {"score": 0.99, "ms": 14, "tokens": 23, "chunks": [{"text": "...", "score": 0.99}]}
//
// The model reads 512 tokens at a time, so longer text is split into chunks and the highest
// chunk score is the answer. Weights download on first start into ./.models.

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { AutoTokenizer, env, pipeline } from '@huggingface/transformers'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
// A third-party ONNX conversion of meta-llama/Llama-Prompt-Guard-2-86M.
const MODEL = arg('model', 'sinatras/Llama-Prompt-Guard-2-86M-ONNX')
// fp32 is accurate and about 1 GB; q8 is about 90 MB and noticeably less accurate.
const DTYPE = arg('dtype', 'fp32')
const PORT = Number(arg('port', 3333))
const CHUNK_TOKENS = 500
const MAX_BODY_BYTES = 2_000_000

env.cacheDir = fileURLToPath(new URL('./.models/', import.meta.url))

console.log(`loading ${MODEL} (${DTYPE}); the first start downloads the weights`)
const tokenizer = await AutoTokenizer.from_pretrained(MODEL)
const classify = await pipeline('text-classification', MODEL, { dtype: DTYPE })
console.log('model ready')

async function score(texts) {
  const chunks = []
  let tokens = 0
  for (const text of texts) {
    const ids = tokenizer.encode(text, { add_special_tokens: false })
    tokens += ids.length
    for (let i = 0; i < Math.max(ids.length, 1); i += CHUNK_TOKENS)
      chunks.push(tokenizer.decode(ids.slice(i, i + CHUNK_TOKENS)))
  }
  const started = performance.now()
  const results = await classify(chunks, { top_k: null })
  // LABEL_1 is "malicious"; the converted model's config carries no label names.
  const scored = results.map((labels, i) => ({
    text: chunks[i],
    score: labels.find((l) => l.label === 'LABEL_1')?.score ?? 0,
  }))
  return {
    score: Math.max(...scored.map((c) => c.score)),
    ms: Math.round(performance.now() - started),
    tokens,
    chunks: scored,
  }
}

async function readBody(req) {
  let body = ''
  for await (const part of req) {
    body += part
    if (body.length > MAX_BODY_BYTES) throw new Error('request too large')
  }
  return JSON.parse(body)
}

createServer(async (req, res) => {
  const json = (status, value) =>
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(await readFile(new URL('./index.html', import.meta.url)))
    } else if (req.method === 'GET' && req.url === '/health') {
      json(200, { model: MODEL, dtype: DTYPE })
    } else if (req.method === 'POST' && req.url === '/classify') {
      const body = await readBody(req)
      const texts = (Array.isArray(body.texts) ? body.texts : [body.text])
        .filter((t) => typeof t === 'string')
        .slice(0, 8)
      if (texts.length === 0) return json(400, { error: 'send "text" or "texts"' })
      json(200, await score(texts))
    } else {
      res.writeHead(404).end()
    }
  } catch (err) {
    json(500, { error: String(err?.message ?? err) })
  }
}).listen(PORT, '127.0.0.1', () => console.log(`classifier on http://localhost:${PORT}`))
