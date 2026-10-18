import { LINE_LOT_CHANNELS, registerLineLotIpc, type LineLotIpcResult } from './line-lot-ipc.ts';
import type { BingoLotSnapshot } from './event-store.ts';

// Bingo lot admission is a thin adapter over the audited Line lot IPC rules (user decision: "Igual que Línea,
// rotulado Bingo"). The strict untrusted identity parser, authorization order, single-flight reservation,
// reentry refusal, uncertainty/read_required latching, committed/recovered taxonomy and refresh gating are the
// shared implementation, unchanged; only the registered channel names and the genuinely Line-labelled output
// messages below are mapped. This module is deliberately unregistered: nothing wires it into main until the
// Bingo lot presentation lands, so it can never start playback on its own.
export const BINGO_LOT_CHANNELS = Object.freeze({ read: 'bingo:lot:read', draw: 'bingo:lot:draw' });
export type BingoLotIpcResult = LineLotIpcResult;

type LotRequest = { sender: unknown; senderFrame: unknown };
type Registrar = {
  handle(channel: string, handler: (event: LotRequest, ...args: unknown[]) => BingoLotIpcResult): void;
};
type LotStore = {
  loadBingoLotResult(): BingoLotSnapshot | null;
  resolveBingoLot(expected: unknown, result: unknown): BingoLotSnapshot;
};
type Ports = Parameters<typeof registerLineLotIpc>[2];

// Every other shared message is already lot-generic; these two are the only Line-labelled texts the shared
// implementation can emit, so they are remapped and nothing else is rewritten.
const BINGO_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  'No first-line lot is available.': 'No bingo lot is available.',
  'Wait for the line celebration to finish first.': 'Wait for the bingo celebration to finish first.',
});

const LINE_TO_BINGO: ReadonlyMap<string, string> = new Map([
  [LINE_LOT_CHANNELS.read, BINGO_LOT_CHANNELS.read],
  [LINE_LOT_CHANNELS.draw, BINGO_LOT_CHANNELS.draw],
]);

export function registerBingoLotIpc(registrar: Registrar, store: LotStore, ports: Ports): void {
  registerLineLotIpc({
    // Only the two shared channels are forwarded, always under their Bingo names; an unknown shared channel
    // is refused rather than registered, so a Line route can never leak through this adapter.
    handle: (channel, handler) => {
      const bingo = LINE_TO_BINGO.get(channel);
      if (bingo === undefined) return;
      registrar.handle(bingo, (event, ...args) => {
        const result = handler(event, ...args);
        if (result.ok) return result;
        const message = BINGO_MESSAGES[result.message];
        return message === undefined ? result : { ...result, message };
      });
    },
  }, {
    loadLineLotResult: () => store.loadBingoLotResult(),
    resolveLineLot: (expected, result) => store.resolveBingoLot(expected, result),
  }, ports);
}
