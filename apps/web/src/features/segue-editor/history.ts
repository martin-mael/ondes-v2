import { useCallback, useReducer } from 'react';

// Undo/redo of the editor (#58). Every edit is one step; a drag is one step too: its first
// move records the state before it (`begin`), the moves after it replace the present only.

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** A drag is in progress: `change` replaces the present without a new step. */
  dragging: boolean;
}

export type HistoryAction<T> =
  | { type: 'change'; next: T }
  | { type: 'begin' }
  | { type: 'end' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'reset'; present: T };

/** Steps kept: enough for a session's work, bounded so a long one doesn't grow forever. */
export const HISTORY_LIMIT = 200;

export const initialHistory = <T>(present: T): History<T> => ({
  past: [],
  present,
  future: [],
  dragging: false,
});

export function historyReducer<T>(state: History<T>, action: HistoryAction<T>): History<T> {
  switch (action.type) {
    case 'change':
      if (Object.is(action.next, state.present)) return state;
      if (state.dragging) return { ...state, present: action.next };
      return {
        past: [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: action.next,
        future: [],
        dragging: false,
      };
    case 'begin':
      return {
        past: [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: state.present,
        future: [],
        dragging: true,
      };
    case 'end': {
      if (!state.dragging) return state;
      // A drag that changed nothing leaves no step behind.
      const before = state.past[state.past.length - 1];
      const past = before === state.present ? state.past.slice(0, -1) : state.past;
      return { ...state, past, dragging: false };
    }
    case 'undo': {
      const previous = state.past[state.past.length - 1];
      if (previous === undefined || state.dragging) return state;
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
        dragging: false,
      };
    }
    case 'redo': {
      const [next, ...future] = state.future;
      if (next === undefined || state.dragging) return state;
      return { past: [...state.past, state.present], present: next, future, dragging: false };
    }
    case 'reset':
      return initialHistory(action.present);
  }
}

export function useHistory<T>(initial: T) {
  const [state, dispatch] = useReducer(
    historyReducer as (s: History<T>, a: HistoryAction<T>) => History<T>,
    initial,
    initialHistory,
  );
  return {
    state,
    change: useCallback((next: T) => dispatch({ type: 'change', next }), []),
    begin: useCallback(() => dispatch({ type: 'begin' }), []),
    end: useCallback(() => dispatch({ type: 'end' }), []),
    undo: useCallback(() => dispatch({ type: 'undo' }), []),
    redo: useCallback(() => dispatch({ type: 'redo' }), []),
    reset: useCallback((present: T) => dispatch({ type: 'reset', present }), []),
  };
}
