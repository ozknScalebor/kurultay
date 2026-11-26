/**
 * Messages for a run that is already going: the Jira issue's description changed, a new
 * comment asks for more. Every agent of the run reads them at the start of its next step and
 * changes course; an agent started later (a fix round) gets all of them, since its task text
 * was written before they came. What no agent read is still there when the run ends, so the
 * caller can hand it over in a follow-up run.
 */
export class Inbox {
  private readonly items: string[] = [];
  private readonly delivered = new Set<number>();

  post(text: string): void {
    if (text.trim()) this.items.push(text.trim());
  }

  /** The messages after `cursor` (marked as read) and the new cursor. */
  take(cursor: number): { texts: string[]; cursor: number } {
    const texts = this.items.slice(cursor);
    for (let i = cursor; i < this.items.length; i++) this.delivered.add(i);
    return { texts, cursor: this.items.length };
  }

  /** Messages no agent has read yet. */
  unread(): string[] {
    return this.items.filter((_, i) => !this.delivered.has(i));
  }

  /** Mark everything as read (handed over some other way). */
  clear(): void {
    for (let i = 0; i < this.items.length; i++) this.delivered.add(i);
  }

  get size(): number {
    return this.items.length;
  }
}

/** What an agent has done so far, saved every step so an interrupted job can go on from there. */
export interface WorkSnapshot {
  worker: string;
  step: number;
  model: string;
  /** every file that differs from the project: content, or null = deleted */
  files: Record<string, string | null>;
  todos?: Array<{ content: string; status: string }>;
  /** the agent's last words (what it was doing) */
  note: string;
  done?: boolean;
}
