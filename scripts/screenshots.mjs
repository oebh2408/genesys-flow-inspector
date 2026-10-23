// Starts the web app on the example flows and captures the images used in the README.
// Needs a local Chromium: set CHROMIUM_PATH or let playwright-core find one.
import { chromium } from 'playwright-core';
import { serve } from '../dist/index.js';

const server = await serve({ paths: ['examples/flows'], inventory: 'examples/inventory.json', port: 0, pollMs: 0 });
const base = `http://localhost:${server.address().port}/`;
const flow = encodeURIComponent('examples/flows/support-line.yaml');

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const shots = [
  { file: 'docs/app-overview.png', scheme: 'light', hash: '#/' },
  { file: 'docs/app-flow.png', scheme: 'dark', hash: `#/flow/${flow}`, click: '.issue >> nth=4' },
];
for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 880 }, colorScheme: shot.scheme, deviceScaleFactor: 2 });
  await page.goto(base + shot.hash);
  await page.waitForSelector('#live.on');
  if (shot.click) await page.click(shot.click);
  await page.waitForTimeout(300);
  await page.screenshot({ path: shot.file, type: 'png' });
  await page.close();
  console.log(shot.file);
}
await browser.close();
server.close();
