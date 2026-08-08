import {
  EnvironmentTemplateSchema,
  sanitizeStoredEnvironmentTemplate,
  type EnvironmentTemplate,
} from "@task-handoff/protocol/control-plane";
import { JsonCollection } from "../../shared/persistence/store.ts";
import type { NodeAgentStorePaths } from "../persistence/paths.ts";

function now() {
  return new Date().toISOString();
}

export class EnvironmentTemplateStore {
  private readonly records: JsonCollection<EnvironmentTemplate>;

  constructor(paths: NodeAgentStorePaths) {
    this.records = new JsonCollection(paths.environmentTemplatesDir, {
      schema: EnvironmentTemplateSchema,
      sanitize: (value) => sanitizeStoredEnvironmentTemplate(value, (warning) => {
        console.warn(JSON.stringify({
          message: "unknown stored environment template field was ignored",
          ...warning,
        }));
      }),
    });
  }

  init() {
    this.records.init();
    for (const template of this.records.list()) {
      if (template.status !== "creating") continue;
      this.records.put(EnvironmentTemplateSchema.parse({
        ...template,
        status: "failed",
        error: {
          code: "ENVIRONMENT_TEMPLATE_CREATION_INTERRUPTED",
          message: "Environment template creation was interrupted by a node-agent restart.",
          phase: "recovery",
        },
        updatedAt: now(),
      }));
    }
  }

  list() {
    return this.records.list();
  }

  get(id: string) {
    return this.records.get(id);
  }

  put(template: EnvironmentTemplate) {
    return this.records.put(EnvironmentTemplateSchema.parse(template));
  }

  patch(id: string, patch: Partial<EnvironmentTemplate>) {
    return this.records.patch(id, patch);
  }

  delete(id: string) {
    return this.records.delete(id);
  }
}
