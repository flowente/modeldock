import type { AuditEventInput, AuditStore, Clock, IdGenerator } from "@modeldock/core";

export interface Logger {
  info(entry: LogEntry): void;
  warn(entry: LogEntry): void;
  error(entry: LogEntry): void;
}

export interface LogEntry {
  module: string;
  action: string;
  correlationId: string;
  durationMs?: number;
  result?: "success" | "failure";
  errorCode?: string;
  details?: Record<string, unknown>;
}

export class ConsoleLogger implements Logger {
  public info(entry: LogEntry): void {
    this.write("info", entry);
  }

  public warn(entry: LogEntry): void {
    this.write("warn", entry);
  }

  public error(entry: LogEntry): void {
    this.write("error", entry);
  }

  private write(level: "info" | "warn" | "error", entry: LogEntry): void {
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      ...entry
    };

    console.log(JSON.stringify(payload));
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private next = 1;

  public createId(prefix: string): string {
    const id = `${prefix}_${String(this.next).padStart(6, "0")}`;
    this.next += 1;
    return id;
  }
}

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}

export function createAuditWriter(store: AuditStore) {
  return {
    append(input: AuditEventInput) {
      return store.append(input);
    }
  };
}

