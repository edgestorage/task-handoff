export type AuthorizationConnectionBinding = {
  userId: string;
  authorizationRevision: number;
};

type Connection = AuthorizationConnectionBinding & { close: () => void };

export class AuthorizationConnectionRegistry {
  private readonly connections = new Set<Connection>();

  track(binding: AuthorizationConnectionBinding, close: () => void) {
    const connection = { ...binding, close };
    this.connections.add(connection);
    return () => this.connections.delete(connection);
  }

  invalidate(userId: string, authorizationRevision: number) {
    let closed = 0;
    for (const connection of [...this.connections]) {
      if (connection.userId !== userId || connection.authorizationRevision === authorizationRevision) continue;
      this.connections.delete(connection);
      try { connection.close(); } catch { /* Authorization is invalid even if transport cleanup already ran. */ }
      closed += 1;
    }
    return closed;
  }

  size() {
    return this.connections.size;
  }
}
