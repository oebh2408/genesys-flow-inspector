// Renders the example flow and captures the images used in the README.
// Needs a local Chromium: set CHROMIUM_PATH or let playwright-core find one.
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { inspect, renderHtml } from '../dist/index.js';

const flow = readFileSync('examples/flows/support-line.yaml', 'utf8');
const html = join(tmpdir(), 'flow-inspector-example.html');
writeFileSync(html, renderHtml(inspect(flow), { source: 'support-line.yaml' }));
mkdirSync('docs', { recursive: true });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const shots = [
  { file: 'docs/viewer-overview.png', scheme: 'light', issue: undefined },
  { file: 'docs/viewer-detail.png', scheme: 'dark', issue: 4 },
];
for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 }, colorScheme: shot.scheme, deviceScaleFactor: 2 });
  await page.goto(`file://${html}`);
  if (shot.issue !== undefined) await page.click(`.issue >> nth=${shot.issue}`);
  await page.waitForTimeout(150);
  await page.screenshot({ path: shot.file, type: 'png' });
  await page.close();
  console.log(shot.file);
}
await browser.close();
