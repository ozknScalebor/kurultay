import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunMode } from '../config.js';

/**
 * Console conversations: every question and task of a console session, saved
 * after each turn so it can be resumed (/resume, --continue), branched
 * (/branch) or rewound (/rewind). Stored per workspace in .kurultay/conversations.
 */
export interface Turn {
  n: number;
  at: string;
  kind: 'ask' | 'run';
  input: string;
  /** answer text, or the run summary */
  output: string;
  /** run turns: orchestrator session and the checkpoint of what was applied */
  run?: { sessionId: string; sessionDir: string; status: string; changedFiles: string[]; checkpointPath?: string };
  /** models that answered / worked */
  models?: string[];
}

export interface ConversationSettings {
  mode?: RunMode;
  intent: 'auto' | 'ask' | 'run';
  dryRun: boolean;
  autoApply: boolean;
  skills: string[];
}

export interface Conversation {
  version: 1;
  id: string;
  title: string;
  workspace: string;
  createdAt: string;
  updatedAt: string;
  /** set when created with /branch */
  parent?: { id: string; turn: number };
  settings: ConversationSettings;
  turns: Turn[];
}

export function conversationsDir(stateDir: string): string {
  return join(stateDir, 'conversations');
}

export function newConversationId(now = new Date()): string {
  return `${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function newConversation(workspace: string, settings: ConversationSettings, parent?: Conversation['parent']): Conversation {
  const now = new Date().toISOString();
  return { version: 1, id: newConversationId(), title: '', workspace, createdAt: now, updatedAt: now, parent, settings: { ...settings, skills: [...settings.skills] }, turns: [] };
}

let lastStamp = 0;
/** Strictly increasing timestamps so "most recent" is well defined even within one millisecond. */
function stamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

export function saveConversation(stateDir: string, c: Conversation): string {
  const dir = conversationsDir(stateDir);
  mkdirSync(dir, { recursive: true });
  c.updatedAt = stamp();
  if (!c.title && c.turns.length) c.title = c.turns[0].input.split('\n')[0].slice(0, 80);
  const file = join(dir, `${c.id}.json`);
  writeFileSync(file, JSON.stringify(c, null, 1));
  return file;
}

export function loadConversation(stateDir: string, id: string): Conversation | undefined {
  try {
    const c = JSON.parse(readFileSync(join(conversationsDir(stateDir), `${id}.json`), 'utf8')) as Conversation;
    return c?.version === 1 && Array.isArray(c.turns) ? c : undefined;
  } catch {
    return undefined;
  }
}

/** Saved conversations, most recently updated first. */
export function listConversations(stateDir: string): Conversation[] {
  const dir = conversationsDir(stateDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => loadConversation(stateDir, f.slice(0, -5)))
    .filter((c): c is Conversation => !!c && c.turns.length > 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Resolve "3" (list position), a full id or a unique id prefix. */
export function findConversation(list: Conversation[], ref: string): Conversation | undefined {
  const r = ref.trim();
  if (/^\d+$/.test(r) && Number(r) >= 1 && Number(r) <= list.length) return list[Number(r) - 1];
  const exact = list.find((c) => c.id === r);
  if (exact) return exact;
  const pre = list.filter((c) => c.id.startsWith(r));
  return pre.length === 1 ? pre[0] : undefined;
}

/** Copy of `c` up to and including turn `upTo` as a new conversation (dallanma). */
export function branchConversation(c: Conversation, upTo = c.turns.length, title?: string): Conversation {
  const b = newConversation(c.workspace, c.settings, { id: c.id, turn: upTo });
  b.turns = c.turns.filter((t) => t.n <= upTo).map((t) => ({ ...t }));
  b.title = title?.trim() || `${c.title || 'conversation'} (branch)`;
  return b;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} days ago`;
}
