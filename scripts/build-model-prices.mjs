#!/usr/bin/env node
// Builds the bundled model price snapshot used by the usage statistics data
// layer (src-tauri/src/usage_stats/pricing.rs).
//
//   node scripts/build-model-prices.mjs [--input <litellm.json>] [--out <path>]
//
// Downloads LiteLLM's public price table (download only, nothing is uploaded)
// and writes a compact snapshot:
//   { "source": "litellm", "snapshotDate": "YYYY-MM-DD",
//     "models": { "<id>": [input, output, cacheRead|null, cacheWrite|null] } }
// Values are USD per token. The filter must stay identical to
// `pricing::compact_litellm` in Rust, which builds the online cache the same way.

import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SOURCE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
// Text-generation modes. "responses" carries OpenAI's Responses-API-only
// models (gpt-5-codex, gpt-5.1-codex, o3-pro …) that Codex CLI reports.
const TEXT_MODES = new Set(["chat", "completion", "responses"]);
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;

function parseArgs(argv) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const config = {
    input: null,
    out: path.resolve(scriptDir, "../src-tauri/resources/pricing/model-prices.json"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token !== "--input" && token !== "--out") {
      throw new Error(`Unknown argument: ${token}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${token}`);
    }
    config[token.slice(2)] = path.resolve(value);
    index += 1;
  }
  return config;
}

async function loadSource(input) {
  if (input) {
    return JSON.parse(await readFile(input, "utf8"));
  }
  const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  const text = await response.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new Error("Price table exceeds the 32MB limit");
  }
  return JSON.parse(text);
}

function costOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function compactLitellm(raw) {
  const models = {};
  for (const id of Object.keys(raw).sort()) {
    const entry = raw[id];
    if (id === "sample_spec" || !entry || typeof entry !== "object") continue;
    // Deep routing paths (fireworks_ai/accounts/<acct>/models/<m>) are never
    // what a CLI reports; dropping them keeps the snapshot small.
    if (id.split("/").length > 3) continue;
    if (!TEXT_MODES.has(entry.mode)) continue;
    const input = costOrNull(entry.input_cost_per_token);
    const output = costOrNull(entry.output_cost_per_token);
    // Both prices are required; an all-zero row is a subscription/free-tier
    // placeholder, and billing real usage at $0 would be a guess.
    if (input === null || output === null || (input === 0 && output === 0)) continue;
    models[id] = [
      input,
      output,
      costOrNull(entry.cache_read_input_token_cost),
      costOrNull(entry.cache_creation_input_token_cost),
    ];
  }
  return models;
}

function utcDate(date) {
  return date.toISOString().slice(0, 10);
}

// One model per line keeps the snapshot diff-friendly when it is refreshed.
function serialize(snapshot) {
  const entries = Object.entries(snapshot.models).map(
    ([id, prices]) => `    ${JSON.stringify(id)}: ${JSON.stringify(prices)}`,
  );
  return [
    "{",
    `  "source": ${JSON.stringify(snapshot.source)},`,
    `  "snapshotDate": ${JSON.stringify(snapshot.snapshotDate)},`,
    '  "models": {',
    entries.join(",\n"),
    "  }",
    "}",
    "",
  ].join("\n");
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const raw = await loadSource(config.input);
  const models = compactLitellm(raw);
  const count = Object.keys(models).length;
  if (count < 100) {
    throw new Error(`Only ${count} priced models found; refusing to write a suspicious snapshot`);
  }
  const snapshot = { source: "litellm", snapshotDate: utcDate(new Date()), models };
  const tmp = `${config.out}.tmp`;
  await writeFile(tmp, serialize(snapshot), "utf8");
  await rename(tmp, config.out);
  process.stdout.write(`Wrote ${count} models to ${config.out}\n`);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`build-model-prices: ${error.message}\n`);
    process.exitCode = 1;
  });
}
