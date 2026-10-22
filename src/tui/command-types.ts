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
  auto: 'tek alt görevde yarış, çok alt görevde paralel dağıtım',
  single: 'tek model',
  split: 'alt görevler farklı modellerde paralel',
  race: 'aynı işi N model yarışarak yapar',
  council: 'yarış + her zaman tam konsey incelemesi',
};

