import type { AuditEvent, AuditEventInput, AuditStore, Clock, IdGenerator } from "@modeldock/core";

export class InMemoryAuditStore implements AuditStore {
  private readonly events: AuditEvent[] = [];
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  public constructor(clock: Clock, ids: IdGenerator) {
    this.clock = clock;
    this.ids = ids;
  }

  public async append(input: AuditEventInput): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: this.ids.createId("audit"),
      timestamp: this.clock.now().toISOString(),
      ...input
    };

    this.events.unshift(event);
    return event;
  }

  public async list(limit = 50): Promise<AuditEvent[]> {
    return this.events.slice(0, limit);
  }
}
