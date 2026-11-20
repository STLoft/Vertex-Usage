// Maintainer-only tool; not required to install or run the browser extension.
import fs from 'node:fs/promises';
import { parsePricing, SOURCE } from '../price-parser.mjs';
const response = await fetch(SOURCE, { signal: AbortSignal.timeout(30000) });
if (!response.ok) throw new Error(`Official price page HTTP ${response.status}`);
const html = await response.text();
if (html.length > 8_000_000) throw new Error('Unexpectedly large pricing page');
const catalog = parsePricing(html);
await fs.writeFile(new URL('../prices.json', import.meta.url), JSON.stringify(catalog, null, 2) + '\n');
console.log(`Official snapshot updated: ${new Set(catalog.rates.map(r => r.model)).size} text models, ${catalog.rates.length} rates. No credentials used.`);
