import assert from 'node:assert/strict';
import test from 'node:test';
import { createManualDrawHandler } from '../src/manual-draw.mjs';

function fixture(valueAsNumber: number, valid: boolean) {
  const drawn: number[] = [];
  let checked = 0;
  let reported = 0;
  const input = {
    valueAsNumber,
    checkValidity: () => { checked++; return valid; },
    reportValidity: () => { reported++; return valid; },
  };
  let click: (() => void) | undefined;
  const button = {
    addEventListener: (event: string, handler: () => void) => {
      assert.equal(event, 'click');
      click = handler;
    },
  };
  button.addEventListener('click', createManualDrawHandler(input, (number: number) => { drawn.push(number); }));
  return { click: () => click?.(), drawn, checked: () => checked, reported: () => reported };
}

for (const number of [1, 90]) {
  test(`valid boundary ${number} dispatches one manual draw`, () => {
    const f = fixture(number, true);
    f.click();
    assert.deepEqual(f.drawn, [number]);
    assert.equal(f.checked(), 1);
    assert.equal(f.reported(), 0);
  });
}

for (const [label, number] of [
  ['empty / NaN', Number.NaN],
  ['fractional', 1.5],
  ['below minimum', 0],
  ['above maximum', 91],
] as const) {
  test(`${label} reports validity without dispatching manual draw`, () => {
    const f = fixture(number, false);
    f.click();
    assert.deepEqual(f.drawn, []);
    assert.equal(f.checked(), 1);
    assert.equal(f.reported(), 1);
  });
}
