import { html } from 'lit';
import './bingo-tabs.mjs';
import './bingo-dialog.mjs';
import { forceState } from '../../.storybook/lib/kit.mjs';

// The host is the tablist; light-DOM role="tab" buttons name their <bingo-tab-panel> via aria-controls.
// Styled by the page (screen.css `.app-tabs`), as in the operator header.
const TABS = [['events', 'Eventos'], ['settings', 'Configuración'], ['bingo', 'Bingo']];

const tabs = ({ selected, prefix }) => html`<div lang="es" class="sb-tabs">
  <div class="app-header" style="grid-template-columns: auto">
    <bingo-tabs class="app-tabs" label="Espacio de trabajo">
      ${TABS.map(([id, label]) => html`<button type="button" role="tab" id=${`${prefix}-tab-${id}`}
        aria-controls=${`${prefix}-panel-${id}`} aria-selected=${String(id === selected)}>${label}</button>`)}
    </bingo-tabs>
  </div>
  ${TABS.map(([id, label]) => html`<bingo-tab-panel id=${`${prefix}-panel-${id}`} aria-labelledby=${`${prefix}-tab-${id}`}
    ?hidden=${id !== selected} style="padding: 1rem">
    <p style="margin: 0">Espacio de trabajo: ${label}</p>
  </bingo-tab-panel>`)}
</div>`;

export default {
  title: 'Components/Tabs',
  component: 'bingo-tabs',
  subcomponents: { 'bingo-tab-panel': 'bingo-tab-panel' },
  args: { selected: 'events' },
  argTypes: {
    selected: { control: 'inline-radio', options: TABS.map(([id]) => id), description: 'Initially selected tab.' },
  },
  parameters: {
    sideBySide: false,
    docs: { description: { component: 'WAI-ARIA tabs with automatic activation and a roving tabindex (Arrow keys, Home, End). '
      + '`canLeave(current, next)` may veto or defer a switch; the operator uses it for the unsaved-changes guard.' } },
  },
  // Ids must be unique per story: docs pages render every story in one document.
  render: (args, { id }) => tabs({ ...args, prefix: id }),
};

export const Events = { name: 'Eventos selected' };

export const Settings = { name: 'Configuración selected', args: { selected: 'settings' } };

export const Hover = { parameters: { pseudo: { hover: true } } };

export const FocusVisible = { name: 'Focus visible', parameters: { pseudo: { focusVisible: true } } };

export const Guarded = {
  name: 'Guarded · canLeave asks first',
  args: { selected: 'settings' },
  parameters: { docs: { description: { story: 'Leaving Configuración opens the unsaved-changes dialog; Cancelar keeps the tab.' } } },
  render: (args) => {
    const view = tabs({ ...args, prefix: 'guarded' });
    requestAnimationFrame(() => {
      const root = document.querySelector('#guarded-tab-settings')?.closest('.sb-tabs');
      const element = root?.querySelector('bingo-tabs');
      const dialog = root?.querySelector('bingo-dialog');
      if (!element || !dialog) return;
      dialog.actions = [
        { action: 'cancel', label: 'Cancelar', signal: 'dismiss' },
        { action: 'discard', label: 'Descartar cambios', signal: 'discard' },
      ];
      element.canLeave = (current) => current.id !== 'guarded-tab-settings' || new Promise((resolve) => {
        dialog.addEventListener('discard', () => resolve(true), { once: true });
        dialog.addEventListener('dismiss', () => resolve(false), { once: true });
        void dialog.show();
      });
    });
    return html`${view}<bingo-dialog lang="es" label="Hay cambios sin guardar"><p>¿Qué quieres hacer con ellos?</p></bingo-dialog>`;
  },
};

export const AllStates = {
  name: 'All states',
  render: () => html`<div style="display: grid; gap: 1rem">
    ${tabs({ selected: 'events', prefix: 'all-a' })}
    ${forceState('hover', tabs({ selected: 'settings', prefix: 'all-b' }))}
    ${forceState('focus-visible', tabs({ selected: 'bingo', prefix: 'all-c' }))}
  </div>`,
};
