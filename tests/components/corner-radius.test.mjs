import { expect } from '@open-wc/testing';
import '../../src/bingo-shell.mjs';
import '../../src/components/bingo-app-shell.mjs';
import '../../src/components/bingo-tabs.mjs';
import '../../src/components/bingo-side-rail.mjs';
import '../../src/components/bingo-button.mjs';
import '../../src/components/bingo-panel.mjs';
import '../../src/components/bingo-status.mjs';
import '../../src/components/bingo-operator-summary.mjs';
import '../../src/components/bingo-call-history.mjs';
import '../../src/components/bingo-operator-board.mjs';
import '../../src/components/bingo-draw-controls.mjs';
import '../../src/components/bingo-dialog.mjs';
import '../../src/components/bingo-event-list.mjs';
import '../../src/components/bingo-tongo-control.mjs';
import '../../src/components/bingo-text-field.mjs';
import '../../src/components/bingo-date-field.mjs';
import '../../src/components/bingo-select-field.mjs';
import '../../src/components/bingo-form-actions.mjs';
import '../../src/components/bingo-number.mjs';
import '../../src/components/bingo-latest-draw.mjs';
import '../../src/components/bingo-number-board.mjs';
import '../../src/components/bingo-tongo.mjs';

const themes = ['jules', 'light', 'high-contrast'];
const corners = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'];
const radii = (element) => corners.map((corner) => getComputedStyle(element)[corner]);
const frames = async () => { for (let frame = 0; frame < 3; frame++) await new Promise((resolve) => requestAnimationFrame(resolve)); };
const page = async (path, selector) => {
  const source = new DOMParser().parseFromString(await (await fetch(new URL(path, import.meta.url))).text(), 'text/html');
  return document.importNode(source.querySelector(selector), true);
};
// Every element in light and shadow trees, so a hard-coded radius anywhere in either window fails. This also covers
// controls whose markup is still changing (such as the audio row), which are deliberately not named below.
function* everyElement(root) {
  for (const element of root.querySelectorAll('*')) {
    yield element;
    if (element.shadowRoot) yield* everyElement(element.shadowRoot);
  }
}

it('every corner is square in both windows and all three themes', async () => {
  const links = await Promise.all(themes.map((name) => new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL(`../../src/generated/${name}.css`, import.meta.url).href;
    link.onload = () => resolve(link);
    link.onerror = reject;
    document.head.append(link);
  })));
  const screen = document.createElement('style');
  screen.textContent = (await (await fetch(new URL('../../src/screen.css', import.meta.url))).text()).replace(/@import [^;]+;/g, '');
  document.head.append(screen);
  const operator = await page('../../src/operator.html', 'bingo-app-shell');
  operator.querySelector('#public-simulator').src = 'about:blank';
  const display = await page('../../src/public.html', 'bingo-shell');
  document.body.append(operator, display);
  try {
    const board = display.querySelector('#called-numbers');
    board.loaded = true;
    board.calledNumbers = [7, 42];
    display.querySelector('#latest-number').value = 42;
    operator.querySelector('#tongo-control').progress = 0.5;
    display.querySelector('#tongo').active = true;
    operator.querySelector('#active-event-banner').message = 'Verbena — 2026-08-15, Plaza';
    await frames();
    const shadow = (host, selector) => operator.querySelector(host).shadowRoot.querySelector(selector);
    const representative = {
      tab: operator.querySelector('#tab-bingo'),
      banner: shadow('#active-event-banner', '[part="message"]'),
      'app mark': operator.querySelector('.app-mark'),
      button: shadow('#open-public', 'button'),
      panel: operator.querySelector('bingo-panel').shadowRoot.querySelector('section'),
      'side rail': operator.querySelector('bingo-side-rail').shadowRoot.querySelector('aside'),
      'text field': shadow('#settings-name', 'input'),
      'select field': shadow('#theme-select', 'select'),
      'board cell': operator.querySelector('bingo-operator-board').shadowRoot.querySelector('.cell'),
      'number input': operator.querySelector('bingo-draw-controls').shadowRoot.querySelector('input[type="number"]'),
      dialog: operator.querySelector('bingo-dialog').shadowRoot.querySelector('dialog'),
      'tongo progress': shadow('#tongo-control', 'progress'),
      'public number': display.querySelector('#latest-number').shadowRoot.querySelector('span'),
      'public board chip': board.shadowRoot.querySelector('bingo-number').shadowRoot.querySelector('span'),
      'public panel': display.querySelector('bingo-panel').shadowRoot.querySelector('section'),
      'public tongo': display.querySelector('#tongo').shadowRoot.querySelector('.card'),
    };
    for (const [name, element] of Object.entries(representative)) expect(element, name).to.be.instanceOf(Element);
    for (const theme of themes) {
      document.documentElement.dataset.theme = theme;
      expect(getComputedStyle(operator).getPropertyValue('--bingo-radius-control').trim(), theme).not.to.equal('');
      for (const [name, element] of Object.entries(representative)) {
        expect(radii(element), `${theme}: ${name}`).to.deep.equal(['0px', '0px', '0px', '0px']);
      }
      const rounded = [...everyElement(document.body)].filter((element) => radii(element).some((radius) => radius !== '0px'))
        .map((element) => `${element.localName}${element.id ? `#${element.id}` : ''}.${element.className}`);
      expect(rounded, theme).to.deep.equal([]);
    }
  } finally {
    operator.remove();
    display.remove();
    links.forEach((link) => link.remove());
    screen.remove();
    delete document.documentElement.dataset.theme;
  }
});
