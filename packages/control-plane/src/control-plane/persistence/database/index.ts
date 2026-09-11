import type { ControlPlaneStorePaths } from "../paths.ts";
import { createControlPlaneUserRepository } from "../../auth/database/index.ts";
import type { ControlPlaneDatabaseRepository } from "./repository.ts";
import {
  resolveControlPlaneDatabaseConfig,
  type ControlPlaneDatabaseConfigInput,
} from "./config.ts";

// The database currently exposes the user repository surface while P0 domain
// repositories are added. Ownership and lifecycle already belong here rather
// than to authentication.
export type ControlPlaneDatabase = ControlPlaneDatabaseRepository;

const collectionMutationMethods = new Set(["put", "delete", "putIfRevision", "insert", "append"]);

function normalizeDatabaseMutationError(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    const record = current as { code?: unknown; message?: unknown; cause?: unknown };
    const code = typeof record.code === "string" ? record.code : "";
    const message = typeof record.message === "string" ? record.message : "";
    const unique = code === "23505" || /UNIQUE constraint failed/i.test(message);
    const foreignKey = code === "23503" || /FOREIGN KEY constraint failed/i.test(message);
    const check = code === "23514" || /CHECK constraint failed/i.test(message);
    if (unique || foreignKey || check) {
      const kind = unique ? "UNIQUE" : foreignKey ? "FOREIGN_KEY" : "CHECK";
      return Object.assign(new Error(`Control Plane database ${kind.toLowerCase().replace("_", " ")} constraint rejected the mutation.`, { cause: error }), {
        code: `CONTROL_PLANE_DATABASE_${kind}_CONFLICT`,
        statusCode: 409,
        retryable: false,
      });
    }
    current = record.cause;
  }
  return error;
}

class ControlPlaneDatabaseLifecycle {
  private readonly repository: ControlPlaneDatabaseRepository;
  private readonly pending = new Set<Promise<unknown>>();
  private acceptingMutations = true;
  private closePromise: Promise<void> | undefined;

  constructor(repository: ControlPlaneDatabaseRepository) {
    this.repository = repository;
  }

  expose(): ControlPlaneDatabase {
    const lifecycle = this;
    return new Proxy(this.repository, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return <T>(operation: (repository: ControlPlaneDatabaseRepository) => Promise<T>) => lifecycle.track(
            () => target.transaction(operation),
          );
        }
        if (property === "putMetadata" || property === "putMigration") {
          const method = Reflect.get(target, property, receiver) as (...args: unknown[]) => Promise<unknown>;
          return (...args: unknown[]) => lifecycle.track(() => method.apply(target, args));
        }
        if (property === "close") return () => lifecycle.close();
        const value = Reflect.get(target, property, receiver);
        if (!value || typeof value !== "object") return value;
        return new Proxy(value, {
          get(collection, method, collectionReceiver) {
            const member = Reflect.get(collection, method, collectionReceiver);
            if (typeof method !== "string" || !collectionMutationMethods.has(method) || typeof member !== "function") return member;
            return (...args: unknown[]) => lifecycle.track(() => member.apply(collection, args));
          },
        });
      },
    });
  }

  private track<T>(operation: () => Promise<T>) {
    if (!this.acceptingMutations) {
      return Promise.reject(Object.assign(new Error("Control Plane database is closing and no longer accepts mutations."), {
        code: "CONTROL_PLANE_DATABASE_QUIESCING",
        statusCode: 503,
        retryable: true,
      }));
    }
    const pending = Promise.resolve().then(operation).catch((error) => { throw normalizeDatabaseMutationError(error); });
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => undefined);
    return pending;
  }

  private close() {
    if (this.closePromise) return this.closePromise;
    this.acceptingMutations = false;
    this.closePromise = (async () => {
      await Promise.allSettled([...this.pending]);
      await this.repository.close();
    })();
    return this.closePromise;
  }
}

export async function createControlPlaneDatabase(
  paths: ControlPlaneStorePaths,
  configured?: ControlPlaneDatabaseConfigInput,
): Promise<ControlPlaneDatabase> {
  const repository = await createControlPlaneUserRepository(paths, resolveControlPlaneDatabaseConfig(paths, configured));
  return new ControlPlaneDatabaseLifecycle(repository).expose();
}

export type { ControlPlaneDatabaseConfigInput } from "./config.ts";
