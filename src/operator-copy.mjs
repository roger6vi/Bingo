import { formatEuros } from './prize-format.mjs';

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
  'Wait for Tongo to finish, then draw again.': 'Espera a que termine el Tongo y vuelve a cantar.',
  // Line celebration guards (src/event-ipc.ts, src/event-catalog-ipc.ts, src/tongo-ipc.ts, src/line-ipc.ts)
  'Wait for the line celebration to finish, then draw again.': 'Espera a que termine la celebración de la línea y vuelve a cantar.',
  'Wait for the line celebration to finish first.': 'Espera a que termine la celebración de la línea.',
  'Wait for the line celebration to finish, then try Tongo again.':
    'Espera a que termine la celebración de la línea y vuelve a intentar el Tongo.',
  'Wait for Tongo to finish, then try again.': 'Espera a que termine el Tongo y vuelve a intentarlo.',
  'The line celebration is not finished.': 'La celebración de la línea aún no ha terminado.',
  'The line celebration cannot be started now.': 'No se puede iniciar la celebración de la línea ahora.',
  // Tongo IPC (src/tongo-ipc.ts)
  'Invalid Tongo request.': 'Solicitud de Tongo no válida.',
  'Tongo is already playing on the public window.': 'El Tongo ya se está mostrando en la pantalla pública.',
  'Tongo is only available during play.': 'El Tongo solo está disponible durante la partida.',
  'Open the public window, then try Tongo again.': 'Abre la pantalla pública y vuelve a intentar el Tongo.',
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
  // First-line IPC (src/line-ipc.ts, event-ipc.ts and catalog guards)
  'Invalid line request.': 'Solicitud de línea no válida. Comprueba el estado de la línea.',
  'This setup is no longer current. Reopen it.':
    'Esta declaración ya no está vigente. Pulsa «Línea» para comprobar el estado.',
  'A first-line setup is already open. Reopen it to continue.':
    'Ya hay una declaración de línea abierta. Pulsa «Línea» para reanudarla y continuar.',
  'The first line cannot be declared now.': 'Ahora no se puede declarar la línea. Comprueba el estado del evento.',
  'A confirmation is in progress. Try again.': 'Hay una confirmación en curso. Comprueba el estado de la línea en unos segundos.',
  'Could not read the first-line state. Try again.': 'No se pudo leer el estado de la línea. Pulsa «Línea» para comprobarlo.',
  'Could not declare the line. Reopen the setup and check the state before trying again.':
    'No se pudo confirmar la línea. No la declares de nuevo: pulsa «Línea» para comprobar el estado.',
  'Finish or cancel the first-line setup, then draw again.': 'Termina o cancela la declaración de la línea y vuelve a cantar.',
  'Finish or cancel the first-line setup first.': 'Termina o cancela la declaración de la línea primero.',
  'Could not connect to the first-line setup. Check the state and try again.':
    'No se pudo conectar con la declaración de la línea. Pulsa «Línea» para comprobar el estado; no la declares de nuevo.',
  'Invalid first-line update. Check the state and try again.':
    'Respuesta de la línea no válida. Pulsa «Línea» para comprobar el estado; no la declares de nuevo.',
  'Could not read the clock. Try again.':
    'No se pudo leer el reloj del equipo. Pulsa «Línea» para comprobar el estado y reintentar.',
  'Enter a whole number of winners, 1 or more.': 'Escribe un número entero de ganadores, 1 o más.',
  'Could not confirm the line celebration. Check the line and try again.':
    'No se pudo confirmar el estado de la celebración de la línea. Pulsa «Línea» para comprobarlo; no se repite sola.',
  // Line lot controller (src/line-lot-controller.mjs)
  'Lot unavailable.': 'El lote no está disponible ahora. Pulsa «Releer estado» para intentarlo de nuevo.',
  'Lot state needs a fresh read.': 'El estado del lote no es fiable. Pulsa «Releer estado» para leerlo de nuevo.',
  'Draw result uncertain; read the lot to continue.':
    'No se pudo confirmar el resultado del sorteo del lote. Pulsa «Releer estado» para leerlo; no se repite solo.',
  // Legacy line check recovery (src/line-ipc.ts and the line controller)
  'There is no line check to cancel.': 'No hay ninguna comprobación de línea que cancelar.',
  'Could not read the line check. Try again or review the event storage.':
    'No se pudo leer la comprobación de línea. Pulsa «Releer comprobación de línea» o revisa el almacenamiento del evento.',
  'Could not cancel the line check. Try again.':
    'No se pudo cancelar la comprobación de línea. Pulsa «Releer comprobación de línea» para leer el estado antes de reintentar.',
  'Could not confirm the line check state. Read it again before trying.':
    'No se pudo confirmar el estado de la comprobación de línea. Pulsa «Releer comprobación de línea» para leerlo; no se repite sola.',
  'A first-line setup is already open. Close it first.':
    'Ya hay una declaración de línea abierta. Ciérrala primero y pulsa «Releer comprobación de línea».',
  'Could not connect to the line check. Read it again before trying.':
    'No se pudo conectar con la comprobación de línea. Pulsa «Releer comprobación de línea» para leer el estado; no se repite sola.',
  'Invalid line check update. Read it again before trying.':
    'Respuesta de la comprobación de línea no válida. Pulsa «Releer comprobación de línea» para leer el estado.',
  // Reciprocal Line guard while a Bingo setup is open (src/line-ipc.ts)
  'Another award setup is already open. Close it first.': 'Hay otra declaración de premio abierta. Ciérrala primero.',
  // Bingo IPC (src/bingo-ipc.ts)
  'Invalid Bingo request.': 'Solicitud de bingo no válida. Vuelve a leer el estado del bingo.',
  'This Bingo setup is no longer current. Reopen it.':
    'Esta declaración de bingo ya no está vigente. Vuelve a leer el estado del bingo antes de seguir.',
  'Could not read the Bingo state. Try again.': 'No se pudo leer el estado del bingo. Inténtalo de nuevo.',
  'No committed Bingo is available to correct.':
    'No hay un bingo confirmado disponible para corregir. Vuelve a leer el estado del bingo.',
  // Explicit event finalization (src/bingo-ipc.ts). The refusal says nothing about a Line: #32's gate is the bingo
  // delivery, and the second message states S16's one-way door, so the operator learns the bingo cannot be corrected.
  'The Bingo cannot be finalized now.':
    'El bingo todavía no se puede finalizar. Espera a que termine la celebración y quede asentado el premio compartido.',
  'The Bingo is already finished.':
    'La partida ya está terminada. El bingo ya no se puede corregir.',
  'No committed line is available to correct.':
    'No hay una línea confirmada disponible para corregir. Vuelve a leer el estado de la línea.',
  'Could not confirm legacy Bingo recovery. Check the state later.':
    'No se pudo confirmar el estado de la comprobación de bingo. Pulsa «Releer comprobación de bingo» para leerlo; no se repite sola.',
  'Could not confirm the Bingo declaration. Keep this setup open and check the state later.':
    'No se pudo confirmar el bingo. No lo declares de nuevo: deja la declaración abierta y vuelve a leer el estado del bingo.',
  'A Bingo operation is already in progress.': 'Ya hay una operación de bingo en curso. Espera y vuelve a leer el estado del bingo.',
  'Wait for the celebration to finish first.': 'Espera a que termine la celebración.',
  'A Bingo setup is already open. Reopen it to continue.': 'Ya hay una declaración de bingo abierta. Ábrela de nuevo para continuar.',
  'A Bingo setup is already open. Close it first.': 'Ya hay una declaración de bingo abierta. Ciérrala primero.',
  'Another setup is open. Close it first.': 'Hay otra declaración abierta. Ciérrala primero.',
  'The Bingo cannot be declared now.': 'Ahora no se puede declarar el bingo. Comprueba el estado del evento.',
  'There is no legacy Bingo check to recover.': 'No hay ninguna comprobación de bingo que cancelar.',
  'The Bingo presentation cannot be started now.': 'No se puede iniciar la celebración del bingo ahora.',
  'Could not start the Bingo presentation. Try again.':
    'No se pudo confirmar el inicio de la celebración del bingo. Vuelve a leer el estado del bingo; no se repite sola.',
  // Bingo controller (src/bingo-controller.mjs)
  'Could not reach the Bingo state. Check it again.':
    'No se pudo conectar con el bingo. Vuelve a leer el estado del bingo; no lo declares de nuevo.',
  'Invalid Bingo update. Check the state again.':
    'Respuesta del bingo no válida. Vuelve a leer el estado del bingo; no lo declares de nuevo.',
  'Bingo is unavailable in this window. Reload the operator.':
    'El bingo no está disponible en esta ventana. Recarga la ventana del operador.',
  'No active event. Choose an event before checking Bingo.': 'No hay ningún evento activo. Elige un evento antes de comprobar el bingo.',
  'Choose how many players share the Bingo (a whole number of at least 1).':
    'Escribe cuántos jugadores comparten el bingo: un número entero, 1 o más.',
  // Renderer controllers
  'Could not connect to the event. Reload and try again.': 'No se pudo conectar con el evento. Recarga e inténtalo de nuevo.',
  'Invalid event update. Reload and try again.': 'Actualización del evento no válida. Recarga e inténtalo de nuevo.',
  'Could not connect to the events. Reload and try again.': 'No se pudo conectar con los eventos. Recarga e inténtalo de nuevo.',
  'Invalid events update. Reload and try again.': 'Actualización de eventos no válida. Recarga e inténtalo de nuevo.',
  'Invalid theme update.': 'Actualización de tema no válida.',
  'Could not connect to theme settings. Try again.': 'No se pudo conectar con la configuración del tema. Inténtalo de nuevo.',
  'Invalid Tongo response.': 'Respuesta de Tongo no válida.',
  'Could not start Tongo. Try again.': 'No se pudo iniciar el Tongo. Inténtalo de nuevo.',
});

// 333 → "3,33 €"; formatEuros supplies the grouped whole part and its trailing " €".
const euroCents = (cents) => `${formatEuros(Math.trunc(cents / 100)).slice(0, -2)},${String(cents % 100).padStart(2, '0')} €`;

// The frozen prize a declaration will use: money, an indivisible lot, both or neither.
const prizeText = ({ amount, lot }) => {
  const parts = [];
  if (amount > 0) parts.push(formatEuros(amount));
  if (lot !== '') parts.push(`lote «${lot}»`);
  return parts.length === 0 ? 'sin premio' : parts.join(' + ');
};
export const linePrizeSummary = (prize) => `Premio de línea configurado: ${prizeText(prize)}.`;
export const bingoPrizeSummary = (prize) => `Premio de bingo configurado: ${prizeText(prize)}.`;

export const isLineInterrupted = (value) => value?.presentation?.status === 'interrupted';

// What each stored presentation status means for the operator; only a completed one says the screen finished.
const PRESENTATION_ES = Object.freeze({
  pending: 'La pantalla pública todavía no muestra la celebración. Los números siguen bloqueados hasta que termine.',
  started: 'La celebración pública está en marcha (unos 4 segundos). Los números siguen bloqueados hasta que termine.',
  failed: 'La celebración pública no pudo mostrarse y no se ha completado. Los números siguen bloqueados: pulsa «Reintentar celebración» para intentarlo de nuevo.',
  interrupted: 'La celebración pública quedó interrumpida al reiniciar la aplicación: no se ha completado ni se repite sola. Los números siguen bloqueados: pulsa «Repetir celebración completa» para mostrarla de nuevo manualmente.',
  completed: 'La celebración pública terminó. Ya puedes seguir cantando números.',
});

// Shown when the celebration finished but the event could not be read again: drawing stays blocked.
export const LINE_REFRESH_FAILED_ES = 'La celebración terminó, pero no se pudo releer el evento. Pulsa «Recargar evento» antes de seguir cantando.';

// What the committed award says plus what the public celebration did; the lot stays separate from the screen.
// The winners, money split and lot of a committed award, shared by the Line and Bingo summaries.
const awardParts = (heading, { winnerCount, totalCents, shareCents, remainderCents, lot, lotResolution }) => {
  const parts = [`${heading} con ${winnerCount} ganador${winnerCount === 1 ? '' : 'es'}.`];
  if (totalCents > 0) {
    parts.push(winnerCount === 1 ? `Premio: ${euroCents(totalCents)}.` : `Premio: ${euroCents(totalCents)}, ${euroCents(shareCents)} cada uno.`);
    if (remainderCents > 0) parts.push(remainderCents === 1 ? 'Sobra 1 céntimo sin asignar.' : `Sobran ${remainderCents} céntimos sin asignar.`);
  }
  if (lot !== '') parts.push(lotResolution === 'pending' ? `Lote «${lot}»: pendiente de resolver entre los ganadores.` : `Lote «${lot}».`);
  return parts;
};

// Unknown statuses read as not shown yet; a completed run never resolves a pending lot.
const awardSummary = (heading, statuses, { award, presentation }) => {
  const parts = awardParts(heading, award);
  const status = presentation?.status;
  parts.push(statuses[Object.hasOwn(statuses, status) ? status : 'pending']);
  if (status === 'completed' && award.lotResolution === 'pending' && award.lot !== '') parts.push('El lote sigue pendiente de resolver.');
  return parts;
};

export function lineAwardSummary(value) {
  return awardSummary('Línea declarada', PRESENTATION_ES, value).join(' ');
}

// The Bingo celebration closes play: no status, completed included, unlocks drawing or finishes the game.
const BINGO_PRESENTATION_ES = Object.freeze({
  pending: 'La pantalla pública todavía no muestra la celebración del bingo.',
  started: 'La celebración pública del bingo está en marcha (unos 4 segundos).',
  failed: 'La celebración pública del bingo no pudo mostrarse y no se ha completado. Pulsa «Reintentar celebración» para intentarlo de nuevo.',
  interrupted: 'La celebración pública del bingo quedó interrumpida al reiniciar la aplicación: no se ha completado ni se repite sola. Pulsa «Repetir celebración completa» para mostrarla de nuevo manualmente.',
  completed: 'La celebración pública del bingo terminó.',
});

export function bingoAwardSummary(value) {
  const parts = awardSummary('Bingo cantado', BINGO_PRESENTATION_ES, value);
  parts.push('La partida sigue en «Bingo cantado»: no se cantan más números.');
  return parts.join(' ');
}

// Shown when a declared Bingo could not be read again; the declaration itself is not repeated.
export const BINGO_REFRESH_FAILED_ES = 'El bingo está cantado, pero no se pudo releer el evento. Pulsa «Recargar evento» para ver el estado.';

// An uncertain Bingo that still holds a pending or started celebration may still be running main-side while the page
// shows nothing, so the locks stay on until that celebration is accounted for. Either a push of the held id or a read
// that confirms it settles the state, and a read that does not confirm it keeps the held award. This reason therefore
// names the one control the operator has, the explicit read, without promising the page is freed.
export const BINGO_UNCERTAIN_LIVE_ES = 'No se pudo confirmar el bingo y su celebración puede seguir en marcha. La página sigue bloqueada hasta confirmar el estado: pulsa «Comprobar bingo»; esta comprobación no se hace sola.';

// Recovery of a legacy checking_line: cancelling returns to drawing without declaring any line or award.
export const LEGACY_CHECK_ES = Object.freeze({
  action: 'Cancelar comprobación de línea',
  reread: 'Releer comprobación de línea',
  back: 'Volver',
  confirm: 'Volver a cantar números',
  dialog: 'Se conservarán los números cantados, su orden y los premios. La partida volverá a cantar números y no se declarará ninguna línea.',
  available: 'La partida quedó en una comprobación de línea antigua. Puedes cancelarla para volver a cantar números.',
  uncertain: 'No se pudo confirmar el estado de la comprobación de línea. Pulsa «Releer comprobación de línea»; no se repite sola.',
  recovered: 'Comprobación de línea cancelada. Esperando el estado del evento para volver a cantar números.',
  refreshFailed: 'Comprobación de línea cancelada, pero no se pudo releer el evento. Pulsa «Recargar evento» antes de seguir cantando.',
});

// Recovery of a legacy checking_bingo: cancelling returns to «Línea cantada» without declaring any Bingo.
export const BINGO_LEGACY_ES = Object.freeze({
  action: 'Cancelar comprobación de bingo',
  reread: 'Releer comprobación de bingo',
  retryRefresh: 'Reintentar lectura del evento',
  back: 'Volver',
  confirm: 'Volver a «Línea cantada»',
  dialog: 'Se conservarán la línea declarada, los números cantados, su orden y los premios. La partida volverá a «Línea cantada» y no se declarará ningún bingo.',
  available: 'La partida quedó en una comprobación de bingo antigua. Puedes cancelarla para volver a «Línea cantada».',
  uncertain: 'No se pudo confirmar el estado de la comprobación de bingo. Pulsa «Releer comprobación de bingo»; no se repite sola.',
  recovered: 'Comprobación de bingo cancelada. La partida vuelve a «Línea cantada».',
  refreshPending: 'Comprobación de bingo cancelada. Leyendo de nuevo el evento…',
  refreshFailed: 'Comprobación de bingo cancelada, pero no se pudo releer el evento. Pulsa «Reintentar lectura del evento».',
});

export const UNKNOWN_ERROR_ES = 'Se produjo un error. Recarga e inténtalo de nuevo.';

// Messages that are already Spanish pass through unchanged.
const SPANISH = new Set(Object.values(MESSAGES_ES));

export function operatorMessage(message) {
  if (message === null || message === undefined || message === '') return message ?? null;
  if (Object.hasOwn(MESSAGES_ES, message)) return MESSAGES_ES[message];
  return SPANISH.has(message) ? message : UNKNOWN_ERROR_ES;
}

// Bingo answers share some English with the Line; only those whose Spanish names a Line action differ here.
const BINGO_MESSAGES_ES = Object.freeze({
  // Legacy bingo check recovery (src/bingo-ipc.ts and the bingo controller)
  'Could not reach the Bingo state. Check it again.':
    'No se pudo conectar con el estado del bingo. Pulsa «Releer comprobación de bingo» para leer el estado; no se repite sola.',
  'Could not read the bingo check. Try again or review the event storage.':
    'No se pudo leer la comprobación de bingo. Pulsa «Releer comprobación de bingo» o revisa el almacenamiento del evento.',
  'Could not read the clock. Try again.': 'No se pudo leer el reloj del equipo. Vuelve a leer el estado del bingo antes de reintentar.',
});
const BINGO_SPANISH = new Set(Object.values(BINGO_MESSAGES_ES));

export function bingoMessage(message) {
  if (typeof message === 'string' && Object.hasOwn(BINGO_MESSAGES_ES, message)) return BINGO_MESSAGES_ES[message];
  return BINGO_SPANISH.has(message) ? message : operatorMessage(message);
}

export const PHASE_LABELS_ES = Object.freeze({
  drawing: 'Cantando números', checking_line: 'Comprobando línea', line_declared: 'Línea cantada',
  checking_bingo: 'Comprobando bingo', bingo_declared: 'Bingo cantado', finished: 'Partida terminada',
});

export const THEME_NAMES_ES = Object.freeze({ jules: 'Jules', light: 'Claro', 'high-contrast': 'Alto contraste' });
