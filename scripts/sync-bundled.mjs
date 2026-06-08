// Generates src/bundledTemplates.js from the committed templates/*.yml copies,
// so the runtime offline-fallback strings can never drift from the files by hand
// transcription. Re-run after updating templates/*.yml:  node scripts/sync-bundled.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (p) => readFileSync(fileURLToPath(new URL(p, root)), 'utf8');
const esc = (s) => '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';

const out =
  `// AUTO-GENERATED from templates/*.yml by scripts/sync-bundled.mjs — do not edit by hand.\n` +
  `// Offline fallback floor used by src/templates.js loadTemplate() when the live\n` +
  `// fetch and the KV cache both miss.\n` +
  `export const bundled = {\n` +
  `  bug: ${esc(read('templates/bug_report.yml'))},\n` +
  `  feature: ${esc(read('templates/feature_request.yml'))},\n` +
  `};\n`;

writeFileSync(fileURLToPath(new URL('src/bundledTemplates.js', root)), out);
console.log('wrote src/bundledTemplates.js');
