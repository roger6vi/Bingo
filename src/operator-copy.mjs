// Spanish copy for the operator window. The main process and the shared controllers report English
// messages; the operator presents them in Spanish. An unknown message falls back to a generic Spanish
// notice rather than showing English copy.
export const MESSAGES_ES = Object.freeze({
  // Draw and event IPC (src/event-ipc.ts)
  'Invalid event request.': 'Solicitud de evento no válida.',
  'All numbers have been called.': 'Ya se han cantado todos los números.',
  'That number has already been called.': 'Ese número ya se ha cantado.',
  'Could not draw a number. Reload and try again.': 'No se pudo sacar un número. Recarga el evento e inténtalo de nuevo.',
  'Could not save the draw. Reload and try again.': 'No se pudo guardar la bola. Recarga el evento e inténtalo de nuevo.',
  'No current event is available.': 'No hay ningún evento activo.',
  'Could not read the current event. Try again.': 'No se pudo leer el evento activo. Inténtalo de nuevo.',
  // Theme IPC (src/theme-ipc.ts)
  'Invalid theme request.': 'Solicitud de tema no válida.',
  'Could not save the theme. Try again.': 'No se pudo guardar el tema. Inténtalo de nuevo.',
  // Event catalog IPC (src/event-catalog-ipc.ts)
  'Could not read the events. Try again.': 'No se pudieron leer los eventos. Inténtalo de nuevo.',
  'Could not create the event. Try again.': 'No se pudo crear el evento. Inténtalo de nuevo.',
  'The event was created, but the list could not be read. Reload the events.':
    'El evento se creó, pero no se pudo leer la lista. Recarga los eventos.',
  'Could not select the event. Reload the events and try again.':
    'No se pudo activar el evento. Recarga los eventos e inténtalo de nuevo.',
  'The event was selected, but the list could not be read. Reload the events.':
    'El evento se activó, pero no se pudo leer la lista. Recarga los eventos.',
  'Could not save the event details. Reload the events and try again.':
    'No se pudieron guardar los datos del evento. Recarga los eventos e inténtalo de nuevo.',
  'The event details were saved, but the list could not be read. Reload the events.':
    'Los datos del evento se guardaron, pero no se pudo leer la lista. Recarga los eventos.',
  // Renderer controllers
  'Could not connect to the event. Reload and try again.': 'No se pudo conectar con el evento. Recarga e inténtalo de nuevo.',
  'Invalid event update. Reload and try again.': 'Actualización del evento no válida. Recarga e inténtalo de nuevo.',
  'Could not connect to the events. Reload and try again.': 'No se pudo conectar con los eventos. Recarga e inténtalo de nuevo.',
  'Invalid events update. Reload and try again.': 'Actualización de eventos no válida. Recarga e inténtalo de nuevo.',
  'Invalid theme update.': 'Actualización de tema no válida.',
  'Could not connect to theme settings. Try again.': 'No se pudo conectar con la configuración del tema. Inténtalo de nuevo.',
});

export const UNKNOWN_ERROR_ES = 'Se produjo un error. Recarga e inténtalo de nuevo.';

// Messages that are already Spanish pass through unchanged.
const SPANISH = new Set(Object.values(MESSAGES_ES));

export function operatorMessage(message) {
  if (message === null || message === undefined || message === '') return message ?? null;
  if (Object.hasOwn(MESSAGES_ES, message)) return MESSAGES_ES[message];
  return SPANISH.has(message) ? message : UNKNOWN_ERROR_ES;
}

export const PHASE_LABELS_ES = Object.freeze({
  drawing: 'Cantando números', checking_line: 'Comprobando línea', line_declared: 'Línea cantada',
  checking_bingo: 'Comprobando bingo', bingo_declared: 'Bingo cantado', finished: 'Partida terminada',
});

export const THEME_NAMES_ES = Object.freeze({ 'pixel-classic': 'Píxel clásico', 'high-contrast': 'Alto contraste' });
