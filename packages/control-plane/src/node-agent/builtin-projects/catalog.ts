import path from "node:path";
import { NodeLocalFolderSchema, type NodeLocalFolder } from "@task-handoff/protocol/control-plane";
import type { BuiltinProjectDefinition } from "./assets.ts";
import { ensureBuiltinProjectMaterialized, readBuiltinProjectMarker } from "./initializer.ts";

/**
 * Built-in project folders are a derived node-agent projection, never persisted
 * state. The shipped manifest is the authority for which projects exist, and the
 * materialization marker on disk is the authority for whether the directory is
 * this product's project, so nothing about them belongs in `na_local_folders`:
 * an operator row there would duplicate the catalog, would have to be kept in
 * sync with the shipped content, and would need its own read-only guards.
 *
 * The projection instead merges into the node agent's folder boundary, so the
 * control panel, the instance creator and the cwd resolver consume one list.
 */

/** Built-in folder ids stay distinguishable from minted operator folder ids. */
export const BUILTIN_PROJECT_FOLDER_ID_PREFIX = "folder_builtin_";

export function builtinProjectFolderId(projectId: string) {
  return `${BUILTIN_PROJECT_FOLDER_ID_PREFIX}${projectId}`;
}

export function builtinProjectTargetDir(targetsDir: string, projectId: string) {
  return path.join(targetsDir, projectId);
}

export type BuiltinProjectPreparation = {
  projectId: string;
  status: "initialized" | "already-initialized" | "failed";
  targetDir: string;
  filesWritten?: number;
  code?: string;
  message?: string;
};

export type BuiltinProjectFolderProjection = {
  /** Materialized built-in folders of this node, ordered by project id. */
  list(): NodeLocalFolder[];
  get(id: string): NodeLocalFolder | undefined;
  /** True for any id owned by a shipped project, materialized or not. */
  owns(id: string): boolean;
  /** Idempotently materializes every applicable project; never throws. */
  prepare(): BuiltinProjectPreparation[];
};

export function createBuiltinProjectFolderProjection(input: {
  definitions: BuiltinProjectDefinition[];
  targetsDir: string;
  nodeId: string;
}): BuiltinProjectFolderProjection {
  // Only the local runtime can host a built-in project: its directory lives on
  // the host file system and every other runtime has to see it inside an
  // instance source directory instead.
  const applicable = input.definitions
    .filter((definition) => definition.runtimes.includes("local"))
    .sort((left, right) => left.id.localeCompare(right.id));
  const byFolderId = new Map(applicable.map((definition) => [builtinProjectFolderId(definition.id), definition]));

  const project = (definition: BuiltinProjectDefinition, marker: { createdAt: string }): NodeLocalFolder => (
    NodeLocalFolderSchema.parse({
      id: builtinProjectFolderId(definition.id),
      nodeId: input.nodeId,
      name: definition.name,
      path: builtinProjectTargetDir(input.targetsDir, definition.id),
      origin: "builtin",
      ...(definition.localizedNames ? { localizedNames: definition.localizedNames } : {}),
      labels: {},
      // The marker is the only authority for when this directory became the
      // product's project, so it also dates the folder.
      createdAt: marker.createdAt,
      updatedAt: marker.createdAt,
    })
  );

  const projectFor = (definition: BuiltinProjectDefinition): NodeLocalFolder | undefined => {
    const targetDir = builtinProjectTargetDir(input.targetsDir, definition.id);
    const marker = readBuiltinProjectMarker(targetDir);
    // A directory materialized by a different project, or by nothing at all, is
    // not this project's folder: the caller must not offer it as one.
    return marker?.projectId === definition.id ? project(definition, marker) : undefined;
  };

  return {
    list() {
      return applicable.flatMap((definition) => {
        const folder = projectFor(definition);
        return folder ? [folder] : [];
      });
    },
    get(id) {
      const definition = byFolderId.get(id);
      return definition ? projectFor(definition) : undefined;
    },
    owns(id) {
      return byFolderId.has(id);
    },
    prepare() {
      return applicable.map((definition) => prepareDefinition(definition, input.targetsDir));
    },
  };
}

function prepareDefinition(definition: BuiltinProjectDefinition, targetsDir: string): BuiltinProjectPreparation {
  const targetDir = builtinProjectTargetDir(targetsDir, definition.id);
  try {
    const result = ensureBuiltinProjectMaterialized(definition, targetDir);
    if (result.projectId !== definition.id) {
      return {
        projectId: definition.id,
        status: "failed",
        targetDir,
        code: "BUILTIN_PROJECT_TARGET_OWNED",
        message: `Built-in project target ${targetDir} is marked as ${result.projectId}.`,
      };
    }
    return {
      projectId: definition.id,
      status: result.status,
      targetDir,
      ...(result.status === "initialized" ? { filesWritten: result.filesWritten } : {}),
    };
  } catch (error) {
    return {
      projectId: definition.id,
      status: "failed",
      targetDir,
      code: (error as { code?: string }).code || "BUILTIN_PROJECT_INITIALIZATION_FAILED",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
