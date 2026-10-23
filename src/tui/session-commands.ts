/** Conversation sessions, rewind and git worktrees of the console (/resume, /branch, /history, /rewind, /worktree). */
import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { modifiedSince, readCheckpoint, rewindCheckpoint } from '../agent/checkpoint.js';
import { color } from '../ui/terminal.js';
import { errorMessage } from '../util/async.js';
import { branchConversation, findConversation, listConversations, relativeTime, saveConversation, type Conversation } from './conversation.js';
import { commitWorktree, createWorktree, currentBranch, listWorktrees, mergeWorktree, realPath, removeWorktree, repoRoot, worktreeDiff, type WorktreeInfo } from './worktree.js';
import { shortPath } from './state.js';
import type { KurultayConsole } from './console.js';
import { plural } from '../util/text.js';

export function conversationList(con: KurultayConsole): Conversation[] {
  return con.app ? listConversations(con.convStateDir) : [];
}

export function printConversations(con: KurultayConsole): void {
  const list = conversationList(con);
  if (!list.length) return con.out(color.dim('No saved sessions. Ask a question or give a task; every turn is saved automatically.'));
  list.slice(0, 15).forEach((c, i) => {
    const cur = c.id === con.conversation?.id ? color.green('●') : ' ';
    const parent = c.parent ? color.dim(` ⑂ ${c.parent.id.slice(0, 19)} #${c.parent.turn}`) : '';
    con.out(`${cur} ${color.cyan(String(i + 1).padStart(2))}) ${c.title || '(untitled)'}  ${color.dim(`${plural(c.turns.length, 'turn')} · ${relativeTime(c.updatedAt)} · ${c.id}`)}${parent}`);
  });
  con.out(color.dim('/resume <number> to continue, /branch to branch'));
}

export function applyConversation(con: KurultayConsole, c: Conversation): void {
  con.conversation = c;
  const s = c.settings;
  con.settings.mode = s.mode;
  con.settings.intent = s.intent;
  con.settings.dryRun = s.dryRun;
  con.settings.autoApply = s.autoApply;
  con.settings.skills = [...s.skills];
  con.askHistory = c.turns.filter((t) => t.kind === 'ask').map((t) => ({ question: t.input, answer: t.output }));
}

/** Continue a saved conversation: settings, question history and a short recap. */
export async function resume(con: KurultayConsole, ref: string): Promise<void> {
  const list = conversationList(con);
  if (!list.length) return con.out(color.dim('No saved session to continue.'));
  const c = findConversation(list, ref);
  if (!c) return con.out(color.yellow(`Session not found: ${ref}. /sessions lists them`));
  applyConversation(con, c);
  con.out(`${color.green('✓')} continuing: ${color.bold(c.title || c.id)} ${color.dim(`(${plural(c.turns.length, 'turn')}, ${relativeTime(c.updatedAt)})`)}`);
  for (const t of c.turns.slice(-3)) {
    con.out(color.dim(`  #${t.n} ${t.kind === 'ask' ? 'question' : 'task'}: `) + t.input.split('\n')[0].slice(0, 100));
    con.out(color.dim(`     → ${t.output.replace(/\s+/g, ' ').slice(0, 160)}`));
  }
}

export function branch(con: KurultayConsole, title: string): void {
  const c = con.conversation;
  if (!c?.turns.length) return con.out(color.yellow('Nothing to branch (no turns yet).'));
  saveConversation(con.convStateDir, c);
  const b = branchConversation(c, c.turns.length, title);
  saveConversation(con.convStateDir, b);
  applyConversation(con, b);
  con.out(`${color.green('✓')} branch created: ${color.bold(b.title)} ${color.dim(b.id)}`);
  con.out(color.dim(`  back to the main conversation: /resume ${c.id}  (code is not branched; use /worktree new <name> for that)`));
}

export function history(con: KurultayConsole): void {
  const c = con.conversation;
  if (!c?.turns.length) return con.out(color.dim('No turns in this session yet.'));
  for (const t of c.turns) {
    const applied = t.run?.checkpointPath ? (readCheckpoint(t.run.checkpointPath)?.rewoundAt ? color.dim(' [undone]') : color.yellow(` [${plural(t.run.changedFiles.length, 'file')} applied]`)) : '';
    con.out(`  ${color.cyan(`#${t.n}`)} ${t.kind === 'ask' ? 'ask ' : 'task'} ${t.input.split('\n')[0].slice(0, 90)}${applied}`);
  }
}

/**
 * Rewind to just before turn `n`: undo every change applied by that turn and
 * the later ones (newest first), and drop those turns from the conversation.
 */
export async function rewind(con: KurultayConsole, arg: string): Promise<void> {
  const c = con.conversation;
  if (!c?.turns.length) return con.out(color.dim('No turn to undo.'));
  let ref = arg.trim();
  if (!ref) {
    history(con);
    const a = await con.screen.readLine(`Go back to before which turn? [1-${c.turns[c.turns.length - 1].n}, empty = cancel] ❯ `);
    ref = (a ?? '').trim();
    if (!ref) return con.out(color.dim('Cancelled.'));
  }
  const n = Number(ref.replace(/^#/, ''));
  if (!Number.isInteger(n) || !c.turns.some((t) => t.n === n)) return con.out(color.yellow(`Invalid turn: ${ref}`));
  const undo = c.turns.filter((t) => t.n >= n && t.run?.checkpointPath && existsSync(t.run.checkpointPath) && !readCheckpoint(t.run.checkpointPath)?.rewoundAt).reverse();
  const root = con.app!.root;
  if (undo.length) {
    const files = [...new Set(undo.flatMap((t) => Object.keys(readCheckpoint(t.run!.checkpointPath!)?.files ?? {})))];
    con.out(`${plural(files.length, 'file')} applied by ${undo.length} task${undo.length === 1 ? '' : 's'} will be restored: ${files.slice(0, 12).join(', ')}${files.length > 12 ? ' …' : ''}`);
    // only the newest checkpoint of each file is compared with the disk: older ones were changed by later turns on purpose
    const seen = new Set<string>();
    const touched: string[] = [];
    for (const t of undo) {
      const cp = readCheckpoint(t.run!.checkpointPath!)!;
      for (const f of modifiedSince(root, cp)) if (!seen.has(f)) touched.push(f);
      for (const f of Object.keys(cp.files)) seen.add(f);
    }
    if (touched.length) con.out(color.yellow(`Warning: these files changed after they were applied; your edits may be lost: ${touched.join(', ')}`));
    if (!(await con.screen.confirm('Undo?'))) return con.out(color.dim('Cancelled.'));
    for (const t of undo) {
      const r = rewindCheckpoint(root, t.run!.checkpointPath!, { force: true });
      con.out(`  ${color.green('↶')} #${t.n}: ${plural(r.restored.length, 'file')} restored`);
    }
  }
  const dropped = c.turns.filter((t) => t.n >= n).length;
  c.turns = c.turns.filter((t) => t.n < n);
  saveConversation(con.convStateDir, c);
  applyConversation(con, c);
  con.out(`${color.green('✓')} back to before #${n} (${plural(dropped, 'turn')} removed from the conversation${undo.length ? ', code restored' : ''}).`);
  con.reindex(true);
}

export function currentWorktrees(con: KurultayConsole): WorktreeInfo[] {
  const root = con.mainRoot ?? con.app!.root;
  return listWorktrees(root);
}

/** /worktree new|list|exit|diff|merge|remove */
export async function worktreeCommand(con: KurultayConsole, arg: string): Promise<void> {
  const [sub = 'list', ...rest] = arg.trim().split(/\s+/).filter(Boolean);
  const name = rest.join(' ');
  const main = con.mainRoot ?? con.app!.root;
  if (!repoRoot(main)) return con.out(color.yellow('This workspace is not a git repository; worktrees are not available.'));
  const find = (n: string): WorktreeInfo | undefined => {
    const all = currentWorktrees(con);
    if (!n && con.mainRoot) return all.find((w) => w.path === realPath(con.app!.root));
    return all.find((w) => w.slug === n || w.branch === n);
  };
  try {
    switch (sub) {
      case 'new':
      case 'add': {
        if (!name) return con.out(color.yellow('Usage: /worktree new <name>'));
        const wt = createWorktree(main, name);
        // reuse the main workspace's index, analysis and capability profile instead of recomputing
        const src = join(main, con.app!.config.stateDir);
        const dst = join(wt.path, con.app!.config.stateDir);
        for (const item of ['index', 'ARCHITECTURE.md', 'INDEX.md', 'modules', 'flows', 'PROJECT_NOTES.md', 'capabilities.json', 'CAPABILITIES.md', 'rules', 'skills', 'review_rules.md']) {
          if (existsSync(join(src, item))) cpSync(join(src, item), join(dst, item), { recursive: true });
        }
        con.mainConfig = existsSync(join(main, 'kurultay.config.json')) ? join(main, 'kurultay.config.json') : con.mainConfig;
        con.mainRoot = main;
        con.out(`${color.green('✓')} worktree: ${shortPath(wt.path)} (branch ${wt.branch})`);
        await con.openWorkspace(wt.path, { keepConversation: true });
        con.out(color.dim('  when done: /worktree diff · /worktree merge · /worktree exit'));
        return;
      }
      case 'list': {
        const all = currentWorktrees(con);
        con.out(`${color.bold('Main repo')}: ${shortPath(main)} ${color.dim(`(⎇ ${currentBranch(main) ?? '?'})`)}${con.mainRoot ? '' : color.green('  ● you are here')}`);
        if (!all.length) return con.out(color.dim('  no worktrees – /worktree new <name>'));
        for (const w of all) con.out(`  ${w.path === realPath(con.app!.root) ? color.green('●') : ' '} ${color.cyan(w.slug)}  ${color.dim(`${w.branch}${w.dirty ? ' · uncommitted changes' : ''}`)}`);
        return;
      }
      case 'exit': {
        if (!con.mainRoot) return con.out(color.dim('You are already in the main repo.'));
        const back = con.mainRoot;
        con.mainRoot = undefined;
        await con.openWorkspace(back, { keepConversation: true });
        con.out(color.dim('  the worktree is kept: /worktree list'));
        return;
      }
      case 'diff': {
        const wt = find(name);
        if (!wt) return con.out(color.yellow(name ? `No worktree named ${name}` : 'Which worktree? /worktree diff <name>'));
        const d = worktreeDiff(main, wt);
        con.out(d.trim() ? con.md('```diff\n' + d + '\n```') : color.dim('(no differences)'));
        return;
      }
      case 'merge': {
        const wt = find(name);
        if (!wt) return con.out(color.yellow(name ? `No worktree named ${name}` : 'Which worktree? /worktree merge <name>'));
        if (!(await con.screen.confirm(`Merge ${wt.branch} into ${currentBranch(main) ?? 'the current branch'} in ${shortPath(main)}?`))) return con.out(color.dim('Cancelled.'));
        const r = mergeWorktree(main, wt);
        if (!r.ok) return con.out(color.red(`Merge failed (rolled back):\n${r.output}`));
        con.out(`${color.green('✓')} ${wt.branch} merged.`);
        if (con.mainRoot) {
          con.mainRoot = undefined;
          await con.openWorkspace(main, { keepConversation: true });
        } else con.reindex(true);
        return;
      }
      case 'commit': {
        const wt = find(name);
        if (!wt) return con.out(color.yellow('Which worktree?'));
        con.out(commitWorktree(wt, `kurultay: ${wt.slug}`) ? `${color.green('✓')} committed (${wt.branch})` : color.dim('Nothing to commit.'));
        return;
      }
      case 'remove':
      case 'rm': {
        const wt = find(name);
        if (!wt) return con.out(color.yellow(name ? `No worktree named ${name}` : 'Usage: /worktree remove <name>'));
        if (!(await con.screen.confirm(`Remove worktree ${wt.slug} and branch ${wt.branch}?${wt.dirty ? ' (uncommitted changes are lost)' : ''}`))) return con.out(color.dim('Cancelled.'));
        if (con.mainRoot && wt.path === realPath(con.app!.root)) {
          con.mainRoot = undefined;
          await con.openWorkspace(main, { keepConversation: true });
        }
        removeWorktree(main, wt);
        con.out(`${color.green('✓')} ${wt.slug} removed.`);
        return;
      }
      default:
        con.out(color.yellow('Usage: /worktree new <name> | list | diff [name] | merge [name] | commit [name] | exit | remove <name>'));
    }
  } catch (e) {
    con.out(color.red(errorMessage(e)));
  }
}
