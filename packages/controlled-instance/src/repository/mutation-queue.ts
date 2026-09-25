export class RepositoryMutationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async withRepository<T>(repositoryKey: string, operation: () => Promise<T>) {
    return this.enqueue(`repository:${repositoryKey}`, operation);
  }

  async withWorktree<T>(worktreeKey: string, operation: () => Promise<T>) {
    return this.enqueue(`worktree:${worktreeKey}`, operation);
  }

  async withRepositoryAndWorktree<T>(repositoryKey: string, worktreeKey: string, operation: () => Promise<T>) {
    return this.withRepositoryAndWorktrees(repositoryKey, [worktreeKey], operation);
  }

  /**
   * Serialize one operation across a set of worktrees. Lanes are acquired in a
   * stable order and duplicate keys collapse into a single lane, so an operation
   * that touches several worktrees can never wait on a lane it already holds.
   */
  async withRepositoryAndWorktrees<T>(repositoryKey: string, worktreeKeys: string[], operation: () => Promise<T>) {
    const lanes = [...new Set(worktreeKeys)].sort();
    const acquire = (index: number): Promise<T> => index === lanes.length
      ? operation()
      : this.withWorktree(lanes[index], () => acquire(index + 1));
    return this.withRepository(repositoryKey, () => acquire(0));
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
