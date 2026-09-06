export class StoryOperationCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private accepting = true;

  async acquire(storyId: string) {
    if (!this.accepting) throw Object.assign(new Error("Story storage is shutting down."), { code: "STORY_STORAGE_QUIESCING", statusCode: 503 });
    const previous = this.tails.get(storyId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(storyId, tail);
    await previous.catch(() => undefined);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
      void tail.finally(() => {
        if (this.tails.get(storyId) === tail) this.tails.delete(storyId);
      });
    };
  }

  async run<T>(storyId: string, operation: () => Promise<T>): Promise<T> {
    const release = await this.acquire(storyId);
    try { return await operation(); } finally { release(); }
  }

  stopAccepting() {
    this.accepting = false;
  }

  async drain() {
    await Promise.all([...this.tails.values()]);
  }

  pendingStoryIds() {
    return [...this.tails.keys()];
  }
}
