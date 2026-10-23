import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Every observable thing that happens is an event (OpenHands-style event sourcing). */
export interface KEvent {
  ts: number;
  type: string;
  /** worker / model / component that produced it */
  source?: string;
  message?: string;
  data?: Record<string, unknown>;
}

export class EventBus extends EventEmitter {
  private logFile?: string;
  readonly history: KEvent[] = [];
  private maxHistory = 5000;

  attachLog(file: string): void {
    mkdirSync(dirname(file), { recursive: true });
    this.logFile = file;
  }

  emitEvent(type: string, fields: Omit<KEvent, 'ts' | 'type'> = {}): KEvent {
    const ev: KEvent = { ts: Date.now(), type, ...fields };
    this.history.push(ev);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
    if (this.logFile) {
      try {
        appendFileSync(this.logFile, JSON.stringify(ev) + '\n');
      } catch {
        /* logging must never break the run */
      }
    }
    this.emit('event', ev);
    this.emit(type, ev);
    return ev;
  }

  /** detail that is only shown with --verbose */
  debug(source: string, message: string, data?: Record<string, unknown>): void {
    this.emitEvent('log.debug', { source, message, data });
  }

  info(source: string, message: string, data?: Record<string, unknown>): void {
    this.emitEvent('log.info', { source, message, data });
  }

  warn(source: string, message: string, data?: Record<string, unknown>): void {
    this.emitEvent('log.warn', { source, message, data });
  }

  error(source: string, message: string, data?: Record<string, unknown>): void {
    this.emitEvent('log.error', { source, message, data });
  }
}
