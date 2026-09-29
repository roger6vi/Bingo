import { operatorMeta } from '../../../.storybook/lib/screens.mjs';
import { EVENTS } from '../../../.storybook/lib/fixtures.mjs';

// src/operator.html, Configuración tab. The 16:9 simulator frames the matching public-display story.
export default {
  title: 'Screens/Operator/Configuración',
  id: 'screens-operator-settings',
  tags: ['!autodocs'],
  ...operatorMeta('settings'),
};

const draft = { name: 'Bingo solidario de otoño', place: 'Parroquia de San Miguel' };
const draftPreview = 'screens-public-display--draft-preview';

export const Saved = { name: 'Saved · no changes' };

export const Draft = {
  name: 'Unsaved draft',
  args: { settings: { draft: { ...draft, theme: 'high-contrast' } }, simulatorStory: draftPreview },
};

export const Invalid = {
  name: 'Validation errors',
  args: { settings: { draft: { name: '   ', place: '', date: '2026-02-30' } } },
};

export const Saving = {
  name: 'Pending · saving',
  args: { settings: { draft, pending: true, themePending: true }, simulatorStory: draftPreview },
};

export const SaveFailed = {
  name: 'Error · save failed',
  args: {
    settings: { draft, error: 'No se guardaron los datos del evento. Los cambios siguen en el borrador; inténtalo de nuevo.' },
    simulatorStory: draftPreview,
  },
};

export const ThemeSaveFailed = {
  name: 'Error · theme not saved',
  args: { settings: { draft: { theme: 'light' }, themeError: 'Could not save the theme. Try again.' }, simulatorStory: draftPreview },
};

export const NoActiveEvent = {
  name: 'Empty · no active event',
  args: { events: { list: EVENTS.map((event) => ({ ...event, active: false })) }, simulatorStory: 'screens-public-display--waiting' },
};

export const LeaveGuard = {
  name: 'Leave with unsaved changes',
  args: { settings: { draft, dialog: true }, simulatorStory: draftPreview },
};
