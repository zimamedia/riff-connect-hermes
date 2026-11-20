// Writes src/riffs.js from the riffs inside the Riff extension, so the inbox and Riff
// describe the same cards.   node scripts/sync-riffs.mjs /path/to/riff-extension
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ext = process.argv[2];
if (!ext) {
  console.error('usage: node scripts/sync-riffs.mjs /path/to/riff-extension');
  process.exit(1);
}
const { RIFFS, SCHEMA_VERSION } = await import(pathToFileURL(path.resolve(ext, 'lib/board/riffs.js')));
const slim = RIFFS.map((r) => ({
  id: r.id,
  name: r.name,
  summary: r.summary,
  unit: r.counter.unit,
  goal: r.goal,
  fields: r.fields.map((f) => ({ id: f.id, label: f.label, required: f.required === true, ...(f.type === 'select' ? { options: f.options.map((o) => ({ value: o.value, label: o.label })) } : { max: f.max || 300 }) })),
}));
const out = `// Made by scripts/sync-riffs.mjs from the Riff extension's lib/board/riffs.js. Do not edit by hand.\n// The inbox uses this to tell an agent which cards it can ask for. Riff checks every request again itself.\n\nexport const PROTOCOL = ${SCHEMA_VERSION};\n\nexport const RIFFS = ${JSON.stringify(slim, null, 2)};\n`;
writeFileSync(new URL('../src/riffs.js', import.meta.url), out);
console.log(`src/riffs.js: ${slim.length} riffs, protocol ${SCHEMA_VERSION}`);
