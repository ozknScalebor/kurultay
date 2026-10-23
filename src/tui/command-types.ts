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

export const MODES: RunMode[] = ['auto', 'single', 'split', 'race', 'council'];
export const MODE_HELP: Record<RunMode, string> = {
  auto: 'race for one subtask, parallel split for many',
  single: 'one model',
  split: 'subtasks run in parallel on different models',
  race: 'N models race on the same work',
  council: 'race + always a full council review',
};

