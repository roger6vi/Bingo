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

// Production registration for the refresh-only E1a boundary. Both commit origins and legacy recovery refresh
// ordinary facts/status; none celebrates. Optional manual ports stay absent, so IPC refuses rather than lies.
export function registerBingoMainWiring(registrar: Registrar, store: Store, ports: Ports) {
  const refresh = (): void => {
    try {
      const snapshot = store.load();
      if (snapshot !== null) ports.publishCommitted(snapshot);
    } catch { /* One failed delivery must not suppress the independent private status refresh. */ }
    let award: StoredBingoAward | null = null;
    try { award = store.loadBingoAward(); }
    catch { /* Clear unreadable operator status; never infer an award or begin playback. */ }
    try { ports.notifyBingo(award); }
    catch { /* An operator window failure cannot undo durable facts. */ }
  };
  return registerBingoIpc(registrar, store, { ...ports, committed: refresh, recovered: refresh });
}
