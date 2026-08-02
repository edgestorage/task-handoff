export class InstanceOperationGate {
  private readonly operations = new Map<string, Promise<void>>();
  private readonly intents = new Map<string, object>();

  intent(instanceId: string) {
    const current = this.intents.get(instanceId);
    if (current) return current;
    const intent = {};
    this.intents.set(instanceId, intent);
    return intent;
  }

  invalidate(instanceId: string) {
    const intent = {};
    this.intents.set(instanceId, intent);
    return intent;
  }

  isIntentCurrent(instanceId: string, intent: object) {
    return this.intents.get(instanceId) === intent;
  }

  clearIntent(instanceId: string) {
    this.intents.delete(instanceId);
  }

  async run<T>(instanceId: string, operation: () => Promise<T>) {
    const previous = this.operations.get(instanceId) || Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.operations.set(instanceId, gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.operations.get(instanceId) === gate) this.operations.delete(instanceId);
    }
  }
}
