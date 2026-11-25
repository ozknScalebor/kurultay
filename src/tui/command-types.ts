import type { RunMode } from '../config.js';
import type { Suggestion } from './editor.js';

export interface Command {
  name: string;
  aliases?: string[];
  args?: string;
  description: string;
  /** needs an open workspace */
  ws?: boolean;
  /** argument suggestions */
  complete?: (arg: string) => Suggestion[];
  run: (arg: string) => Promise<void> | void;
}

export const MODES: RunMode[] = ['auto', 'single', 'multi', 'split', 'race', 'council'];
export const MODE_HELP: Record<RunMode, string> = {
  auto: 'one model at a time; another model takes over when it stops answering (default)',
  single: 'one model (same as auto)',
  multi: 'several models: race for one subtask, parallel split for many',
  split: 'subtasks run in parallel on different models',
  race: 'N models race on the same work',
  council: 'race + always a full council review',
};

