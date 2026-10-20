import { registerLineIpc } from './line-ipc.ts';
import type { StoredLineAward } from './event-store.ts';

type Registrar = Parameters<typeof registerLineIpc>[0];
type Ports = Pick<Parameters<typeof registerLineIpc>[2],
  'authorize' | 'now' | 'busy' | 'tongoPlaying' | 'otherSetupActive'> & {
  publishCommitted(snapshot: { calledNumbers: readonly number[]; phase: import('./game-phase.ts').GamePhase;
    lastTransitionAt: string | null }): void;
  begin?(award: StoredLineAward): void;
  retry?(presentationId: string): void | boolean;
  repeat?(presentationId: string): void | boolean;
};

// Refresh facts for the audited correction (#29): the public window re-reads the committed drawing snapshot
// and the operator window refreshes from its own dispatch settle. A correction never celebrates and never
// pushes an award; only an explicit declaration begins a persisted pending award's playback.
export function registerLineMainWiring(registrar: Registrar, store: Parameters<typeof registerLineIpc>[1],
    ports: Ports) {
  const refresh = (): StoredLineAward | null => {
    try {
      const snapshot = store.load();
      if (snapshot !== null) ports.publishCommitted(snapshot);
    } catch { /* One failed delivery must not suppress the operator's independent refresh. */ }
    let award: StoredLineAward | null = null;
    try { award = store.loadLineAward(); }
    catch { /* Unreadable operator status; never infer an award or begin playback. */ }
    return award;
  };
  return registerLineIpc(registrar, store, {
    authorize: ports.authorize, now: ports.now, busy: ports.busy, tongoPlaying: ports.tongoPlaying,
    otherSetupActive: ports.otherSetupActive,
    publish: (snapshot) => ports.publishCommitted(snapshot),
    committed: (award) => ports.begin?.(award),
    corrected: () => { refresh(); },
    retry: (id) => (ports.retry ? ports.retry(id) : false),
    repeat: (id) => (ports.repeat ? ports.repeat(id) : false),
  });
}
