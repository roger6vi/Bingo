// Transition intents describe domain decisions, not UI actions or storage records.
export const GAME_PHASES = [
  'drawing', 'checking_line', 'line_declared',
  'checking_bingo', 'bingo_declared', 'finished',
] as const;

export type GamePhase = (typeof GAME_PHASES)[number];

export interface PhaseState {
  readonly phase: GamePhase;
}

const transitions = {
  drawing: { begin_line_check: 'checking_line', declare_line_directly: 'line_declared' },
  checking_line: { declare_line: 'line_declared', reject_line_claim: 'drawing' },
  line_declared: { begin_bingo_check: 'checking_bingo', correct_line_declaration: 'drawing' },
  checking_bingo: { declare_bingo: 'bingo_declared', reject_bingo_claim: 'line_declared' },
  bingo_declared: { finish: 'finished', correct_bingo_declaration: 'line_declared' },
  finished: {},
} as const satisfies Record<GamePhase, Record<string, GamePhase>>;

export type PhaseTransitionIntent = {
  [Phase in GamePhase]: keyof (typeof transitions)[Phase];
}[GamePhase];

export function createPhaseState(): PhaseState {
  return Object.freeze({ phase: 'drawing' });
}

export function transitionPhase(state: PhaseState, intent: PhaseTransitionIntent): PhaseState {
  const next = (transitions[state.phase] as Partial<Record<PhaseTransitionIntent, GamePhase>>)[intent];
  if (next === undefined) {
    throw new Error(`Invalid phase transition: ${state.phase} via ${intent}`);
  }
  return Object.freeze({ phase: next });
}

export function assertDrawAllowed(state: PhaseState): void {
  if (state.phase !== 'drawing' && state.phase !== 'line_declared') {
    throw new Error(`Draw not allowed in phase ${state.phase}`);
  }
}
