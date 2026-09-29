#!/usr/bin/env node
// Checks the static Storybook (npm run storybook:build first) in headless Chromium:
//  1. every src/components/*.mjs has a sibling *.stories.mjs;
//  2. every story renders in every registered theme without console errors;
//  3. axe-core (the engine behind the a11y addon, same defaults: `region` off) reports no violations;
//  4. nothing is requested from outside the local server (Storybook must work offline).
// Options: --stories <substring> filters story ids; --screenshots <dir> saves each story per theme at
// 1280×720; STORYBOOK_VERIFY_CHROMIUM=/path/to/chrome overrides Playwright's bundled browser.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { sourcePaths } from '../scripts/token-contract.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const staticDir = path.join(root, 'storybook-static');
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const filter = option('--stories');
const screenshots = option('--screenshots');
const failures = [];

// 1. Story coverage: one story file per shared component.
const componentsDir = path.join(root, 'src/components');
for (const file of readdirSync(componentsDir)) {
  if (!file.endsWith('.mjs') || file.endsWith('.stories.mjs')) continue;
  const stories = file.replace(/\.mjs$/, '.stories.mjs');
  if (!existsSync(path.join(componentsDir, stories))) failures.push(`src/components/${file}: missing ${stories}`);
}

if (!existsSync(path.join(staticDir, 'index.json'))) {
  console.error('storybook-static/index.json not found. Run `npm run storybook:build` first.');
  process.exit(1);
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.png': 'image/png' };
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const file = path.join(staticDir, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!file.startsWith(staticDir) || !existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
  response.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const index = JSON.parse(readFileSync(path.join(staticDir, 'index.json'), 'utf8'));
const stories = Object.values(index.entries)
  .filter((entry) => entry.type === 'story' && (!filter || entry.id.includes(filter)));
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

const browser = await chromium.launch({ executablePath: process.env.STORYBOOK_VERIFY_CHROMIUM || undefined });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion: 'reduce' });
await context.route('**/*', (route) => {
  const url = route.request().url();
  if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
  failures.push(`external request blocked: ${url}`);
  return route.abort();
});
if (screenshots) mkdirSync(screenshots, { recursive: true });

let checked = 0;
for (const story of stories) {
  for (const theme of sourcePaths.themes) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`${origin}/iframe.html?id=${story.id}&viewMode=story&globals=theme:${theme}`);
    // Storybook marks the body once the story (and its play function) has rendered or failed.
    await page.waitForFunction(() => document.body.classList.contains('sb-show-main')
      || document.body.classList.contains('sb-show-errordisplay'), null, { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    const label = `${story.title} › ${story.name} [${theme}]`;
    if (await page.evaluate(() => document.body.classList.contains('sb-show-errordisplay'))) {
      errors.push(await page.locator('#error-message').innerText());
    }
    if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) errors.push('theme not applied');
    if (!await page.evaluate(() => Boolean(window.axe))) await page.addScriptTag({ content: axeSource });
    const violations = await page.evaluate(async () => {
      // The a11y addon may still be running its own pass over the story; axe allows one run at a time.
      for (let attempt = 0; ; attempt++) {
        try {
          const result = await window.axe.run('#storybook-root', { rules: { region: { enabled: false } } });
          return result.violations.map((violation) => `${violation.id} (${violation.impact}): ${violation.help} — ${
            violation.nodes.slice(0, 3).map((node) => node.target.join(' ')).join(', ')}`);
        } catch (error) {
          if (attempt > 50 || !/already running/.test(error.message)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    });
    for (const message of [...errors, ...violations]) failures.push(`${label}: ${message}`);
    if (screenshots) await page.screenshot({ path: path.join(screenshots, `${story.id}--${theme}.png`), fullPage: true });
    await page.close();
    checked++;
  }
}

await browser.close();
server.close();
if (failures.length) {
  console.error(`Storybook verification failed (${failures.length}):\n${failures.map((line) => `  ✗ ${line}`).join('\n')}`);
  process.exit(1);
}
console.log(`Storybook verified: ${stories.length} stories × ${sourcePaths.themes.length} themes (${checked} renders), `
  + 'no a11y violations, no console errors, no external requests, every component has stories.');
