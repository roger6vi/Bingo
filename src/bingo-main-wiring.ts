import { registerBingoIpc } from './bingo-ipc.ts';
import type { StoredBingoAward } from './event-store.ts';

type Registrar = Parameters<typeof registerBingoIpc>[0];
type Store = Parameters<typeof registerBingoIpc>[1] & {
  load(): Parameters<Ports['publishCommitted']>[0] | null;
};
type Ports = Pick<Parameters<typeof registerBingoIpc>[2],
  'authorize' | 'now' | 'tongoPlaying' | 'presentationBusy' | 'otherSetupActive'> & {
  publishCommitted(snapshot: { calledNumbers: readonly number[]; phase: import('./game-phase.ts').GamePhase;
    lastTransitionAt: string | null }): void;
  notifyBingo(award: StoredBingoAward | null): void;
  begin?(award: StoredBingoAward): void;
  retry?(presentationId: string): void | boolean;
  repeat?(presentationId: string): void | boolean;
};

// Startup-only durable cleanup. No delivery, window, declaration or playback exists yet.
export function recoverBingoPresentations(store: {
  interruptStartedBingoPresentations(): unknown;
  failPendingBingoPresentations(): unknown;
}): void {
  store.interruptStartedBingoPresentations();
  store.failPendingBingoPresentations();
}

export const sharedSetupActive = (line: { active(): boolean }, bingo: { active(): boolean }) =>
  () => line.active() || bingo.active();

// Refresh facts/status for both commit origins and legacy recovery. Only explicit confirmation may begin
// a persisted pending award; reads, startup and window attachment never celebrate.
export function registerBingoMainWiring(registrar: Registrar, store: Store, ports: Ports) {
  const refresh = (): StoredBingoAward | null => {
    try {
      const snapshot = store.load();
      if (snapshot !== null) ports.publishCommitted(snapshot);
    } catch { /* One failed delivery must not suppress the independent private status refresh. */ }
    let award: StoredBingoAward | null = null;
    try { award = store.loadBingoAward(); }
    catch { /* Clear unreadable operator status; never infer an award or begin playback. */ }
    try { ports.notifyBingo(award); }
    catch { /* An operator window failure cannot undo durable facts. */ }
    return award;
  };
  return registerBingoIpc(registrar, store, {
    ...ports,
    committed: (origin) => {
      const award = refresh();
      if (origin === 'confirm' && award?.presentation.status === 'pending') ports.begin?.(award);
      // IPC contains callback errors: failed playback cannot undo a durable declaration.
    },
    recovered: refresh,
    // Thin invocation-time lookups preserve late assignment, refusal and genuine void acceptance.
    retry: (id) => ports.retry ? ports.retry(id) : false,
    repeat: (id) => ports.repeat ? ports.repeat(id) : false,
  });
}
