#!/usr/bin/env node
// Checks the static Storybook (npm run storybook:build first) in headless Chromium:
//  1. every src/components/*.mjs that registers an element has a sibling *.stories.mjs;
//  2. every story renders in every registered theme without console errors;
//  3. axe-core (the engine behind the a11y addon, same defaults: `region` off) reports no violations;
//  4. nothing is requested from outside the local server (Storybook must work offline);
//  5. every element in the story (shadow roots included) has square corners: all radii compute to 0px;
//  6. composed screens render (and are checked) at their reference viewport: operator screens at 1280×720, the
//     public display at 1920×1080. Components render at 1280×720 (one viewport per story, not a matrix).
// Every failure names the story, theme, viewport and assertion.
// Options: --stories <substring> filters story ids; --screenshots <dir> saves every render; --failures <dir>
// saves a screenshot of each failing render plus failures.txt (CI uploads it);
// STORYBOOK_VERIFY_CHROMIUM=/path/to/chrome overrides Playwright's bundled browser.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
const failureDir = option('--failures');
const failures = [];

// Reference viewports (issue #94). Screen stories are matched by title so a new or renamed screen must be
// assigned one here instead of silently falling back to the component default.
const VIEWPORTS = {
  component: { width: 1280, height: 720 },
  operator: { width: 1280, height: 720 },
  public: { width: 1920, height: 1080 },
};
const surfaceOf = (title) => {
  if (title.startsWith('Screens/Operator/')) return 'operator';
  if (title === 'Screens/Public display') return 'public';
  if (title.startsWith('Screens/')) return undefined;
  return 'component';
};

// 1. Story coverage: one story file per shared component (a module that registers a custom element;
// shared bases such as bingo-field.mjs are covered through the fields built on them).
const componentsDir = path.join(root, 'src/components');
for (const file of readdirSync(componentsDir)) {
  if (!file.endsWith('.mjs') || file.endsWith('.stories.mjs')) continue;
  if (!/customElements\.define\(/.test(readFileSync(path.join(componentsDir, file), 'utf8'))) continue;
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
for (const story of stories) {
  if (!surfaceOf(story.title)) failures.push(`${story.title} › ${story.name}: screen story has no reference viewport in verify.mjs`);
}
const counts = { component: 0, operator: 0, public: 0 };
for (const story of stories) if (surfaceOf(story.title)) counts[surfaceOf(story.title)]++;
// A title change must not quietly drop the viewport gates.
if (!filter && (!counts.operator || !counts.public)) failures.push(`expected operator and public screen stories, found ${JSON.stringify(counts)}`);
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

const browser = await chromium.launch({ executablePath: process.env.STORYBOOK_VERIFY_CHROMIUM || undefined });
const context = await browser.newContext({ viewport: VIEWPORTS.component, reducedMotion: 'reduce' });
let label = 'Storybook';
await context.route('**/*', (route) => {
  const url = route.request().url();
  if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
  failures.push(`${label}: external request blocked: ${url}`);
  return route.abort();
});
if (screenshots) mkdirSync(screenshots, { recursive: true });
if (failureDir) mkdirSync(failureDir, { recursive: true });

let checked = 0;
for (const story of stories) {
  const surface = surfaceOf(story.title);
  if (!surface) continue;
  const viewport = VIEWPORTS[surface];
  for (const theme of sourcePaths.themes) {
    const page = await context.newPage();
    await page.setViewportSize(viewport);
    label = `${story.title} › ${story.name} [${theme} @ ${viewport.width}×${viewport.height}] (${story.id})`;
    const before = failures.length;
    const errors = [];
    page.on('pageerror', (error) => errors.push(`page error: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console error: ${message.text().split('\n')[0]}`);
    });
    try {
      await page.goto(`${origin}/iframe.html?id=${story.id}&viewMode=story&globals=theme:${theme}`);
      // Storybook marks the body once the story (and its play function) has rendered or failed.
      await page.waitForFunction(() => document.body.classList.contains('sb-show-main')
        || document.body.classList.contains('sb-show-errordisplay'), null, { timeout: 15000 });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(150);
      if (await page.evaluate(() => document.body.classList.contains('sb-show-errordisplay'))) {
        errors.push(`story failed: ${await page.locator('#error-message').innerText()}`);
      }
      if (await page.evaluate(() => document.documentElement.dataset.theme) !== theme) errors.push('theme not applied');
      if (surface !== 'component') {
        const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        if (size.width !== viewport.width || size.height !== viewport.height) errors.push(`viewport is ${size.width}×${size.height}`);
      }
      if (!await page.evaluate(() => Boolean(window.axe))) await page.addScriptTag({ content: axeSource });
      const violations = await page.evaluate(async () => {
        // The a11y addon may still be running its own pass over the story; axe allows one run at a time.
        for (let attempt = 0; ; attempt++) {
          try {
            const result = await window.axe.run('#storybook-root', { rules: { region: { enabled: false } } });
            return result.violations.map((violation) => `a11y ${violation.id} (${violation.impact}): ${violation.help} — ${
              violation.nodes.slice(0, 3).map((node) => node.target.join(' ')).join(', ')}`);
          } catch (error) {
            if (attempt > 50 || !/already running/.test(error.message)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        }
      });
      errors.push(...violations);
      const rounded = await page.evaluate(() => {
        const found = [];
        const walk = (root) => {
          for (const element of root.querySelectorAll('*')) {
            const style = getComputedStyle(element);
            const radii = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius];
            if (radii.some((radius) => radius !== '0px')) found.push(`${element.localName}${element.id ? `#${element.id}` : ''} (${radii.join(' ')})`);
            if (element.shadowRoot) walk(element.shadowRoot);
          }
        };
        walk(document.querySelector('#storybook-root'));
        return found;
      });
      errors.push(...rounded.slice(0, 3).map((element) => `rounded corner: ${element}`));
    } catch (error) {
      errors.push(`verification error: ${error.message.split('\n')[0]}`);
    }
    for (const message of errors) failures.push(`${label}: ${message}`);
    const file = `${story.id}--${theme}--${viewport.width}x${viewport.height}.png`;
    if (screenshots) await page.screenshot({ path: path.join(screenshots, file), fullPage: true }).catch(() => {});
    if (failureDir && failures.length > before) await page.screenshot({ path: path.join(failureDir, file), fullPage: true }).catch(() => {});
    await page.close();
    checked++;
  }
}

await browser.close();
server.close();
if (failures.length) {
  if (failureDir) writeFileSync(path.join(failureDir, 'failures.txt'), `${failures.join('\n')}\n`);
  console.error(`Storybook verification failed (${failures.length}):\n${failures.map((line) => `  ✗ ${line}`).join('\n')}`);
  process.exit(1);
}
console.log(`Storybook verified: ${stories.length} stories × ${sourcePaths.themes.length} themes (${checked} renders; `
  + `${counts.component} component stories @ 1280×720, ${counts.operator} operator screens @ 1280×720, `
  + `${counts.public} public screens @ 1920×1080), no a11y violations, no console errors, no external requests, no rounded corners, `
  + 'every component has stories.');
