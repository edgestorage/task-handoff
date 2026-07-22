export class RepositoryMutationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async withRepository<T>(repositoryKey: string, operation: () => Promise<T>) {
    return this.enqueue(`repository:${repositoryKey}`, operation);
  }

  async withWorktree<T>(worktreeKey: string, operation: () => Promise<T>) {
    return this.enqueue(`worktree:${worktreeKey}`, operation);
  }

  async withRepositoryAndWorktree<T>(repositoryKey: string, worktreeKey: string, operation: () => Promise<T>) {
    return this.withRepository(repositoryKey, () => this.withWorktree(worktreeKey, operation));
  }

  private async enqueue<T>(key: string, operation: () => Promise<T>) {
    const previous = this.tails.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}
