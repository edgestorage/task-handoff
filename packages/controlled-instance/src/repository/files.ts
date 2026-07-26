import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RepositoryDirectoryListingSchema, RepositoryFileContentSchema } from "@task-handoff/protocol/repository";
import type { z } from "zod";

type RepositoryDirectoryListing = z.infer<typeof RepositoryDirectoryListingSchema>;
type RepositoryFileContent = z.infer<typeof RepositoryFileContentSchema>;

export class RepositoryFileError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RepositoryFileError";
  }
}

export class RepositoryFileService {
  readonly root: string;
  readonly boundaryRoot: string;

  constructor(root: string, private readonly maxFileBytes = 4 * 1024 * 1024, boundaryRoot = root) {
    this.root = fs.realpathSync(root);
    if (!fs.statSync(this.root).isDirectory()) throw new RepositoryFileError("REPOSITORY_CWD_INACCESSIBLE", "Repository root is not a directory.");
    this.boundaryRoot = fs.realpathSync(boundaryRoot);
    if (!fs.statSync(this.boundaryRoot).isDirectory()) throw new RepositoryFileError("REPOSITORY_CWD_INACCESSIBLE", "Workspace boundary is not a directory.");
    if (!withinRoot(this.root, this.boundaryRoot)) {
      throw new RepositoryFileError("REPOSITORY_PATH_FORBIDDEN", "Repository root is outside the instance workspace boundary.");
    }
  }

  list(relativePath = ""): RepositoryDirectoryListing {
    const resolved = this.resolve(relativePath, { allowRoot: true, mustExist: true });
    const stat = fs.lstatSync(resolved.absolutePath);
    if (!stat.isDirectory()) throw new RepositoryFileError("REPOSITORY_PATH_INVALID", "Directory path does not identify a directory.");
    const entries = fs.readdirSync(resolved.absolutePath, { withFileTypes: true })
      .filter((entry) => entry.name.toLowerCase() !== ".git")
      .map((entry) => {
        const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const absolutePath = path.join(resolved.absolutePath, entry.name);
        const entryStat = fs.lstatSync(absolutePath);
        const kind = this.kind(absolutePath, entryStat);
        return {
          name: entry.name,
          path: entryPath,
          kind,
          traversable: entryStat.isDirectory(),
          editable: kind === "file" && entryStat.size <= this.maxFileBytes,
          ...(kind === "file" ? { size: entryStat.size, mode: fileMode(entryStat) } : {}),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    return { path: relativePath, entries, snapshotId: directoryVersion(entries) };
  }

  read(relativePath: string): RepositoryFileContent {
    const resolved = this.resolve(relativePath, { mustExist: true });
    const stat = fs.lstatSync(resolved.absolutePath);
    this.assertRegularFile(resolved.absolutePath, stat);
    if (stat.size > this.maxFileBytes) throw new RepositoryFileError("REPOSITORY_FILE_TOO_LARGE", `File exceeds ${this.maxFileBytes} bytes.`);
    const buffer = fs.readFileSync(resolved.absolutePath);
    if (buffer.includes(0)) throw new RepositoryFileError("REPOSITORY_FILE_BINARY", "Binary files cannot be opened in the text editor.");
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new RepositoryFileError("REPOSITORY_FILE_BINARY", "File is not valid UTF-8 text.");
    }
    return {
      path: relativePath,
      content,
      byteLength: buffer.length,
      version: fileVersion(buffer, stat),
      mode: fileMode(stat),
    };
  }

  create(relativePath: string, content: string) {
    const resolved = this.resolve(relativePath, { mustExist: false });
    if (fs.existsSync(resolved.absolutePath)) throw new RepositoryFileError("REPOSITORY_FILE_EXISTS", "Destination already exists.");
    const buffer = textBuffer(content, this.maxFileBytes);
    try {
      fs.writeFileSync(resolved.absolutePath, buffer, { flag: "wx", mode: 0o644 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RepositoryFileError("REPOSITORY_FILE_EXISTS", "Destination already exists.");
      throw error;
    }
    return this.read(relativePath);
  }

  write(relativePath: string, content: string, expectedVersion: string) {
    const current = this.read(relativePath);
    if (current.version !== expectedVersion) throw new RepositoryFileError("REPOSITORY_FILE_STALE", "File changed after it was opened.");
    const resolved = this.resolve(relativePath, { mustExist: true });
    const buffer = textBuffer(content, this.maxFileBytes);
    const stat = fs.statSync(resolved.absolutePath);
    const tempPath = path.join(path.dirname(resolved.absolutePath), `.${path.basename(resolved.absolutePath)}.task-handoff-${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tempPath, buffer, { flag: "wx", mode: stat.mode & 0o777 });
      if (this.read(relativePath).version !== expectedVersion) throw new RepositoryFileError("REPOSITORY_FILE_STALE", "File changed while it was being saved.");
      fs.renameSync(tempPath, resolved.absolutePath);
      fs.chmodSync(resolved.absolutePath, stat.mode & 0o777);
    } finally {
      try { fs.unlinkSync(tempPath); } catch {}
    }
    return this.read(relativePath);
  }

  rename(relativePath: string, destination: string, expectedVersion: string) {
    const current = this.read(relativePath);
    if (current.version !== expectedVersion) throw new RepositoryFileError("REPOSITORY_FILE_STALE", "File changed before it was renamed.");
    const source = this.resolve(relativePath, { mustExist: true });
    const target = this.resolve(destination, { mustExist: false });
    if (fs.existsSync(target.absolutePath)) throw new RepositoryFileError("REPOSITORY_FILE_EXISTS", "Destination already exists.");
    try {
      fs.linkSync(source.absolutePath, target.absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RepositoryFileError("REPOSITORY_FILE_EXISTS", "Destination already exists.");
      throw error;
    }
    try {
      fs.unlinkSync(source.absolutePath);
    } catch (error) {
      try { fs.unlinkSync(target.absolutePath); } catch {}
      throw error;
    }
    return this.read(destination);
  }

  delete(relativePath: string, expectedVersion: string) {
    const current = this.read(relativePath);
    if (current.version !== expectedVersion) throw new RepositoryFileError("REPOSITORY_FILE_STALE", "File changed before it was deleted.");
    fs.unlinkSync(this.resolve(relativePath, { mustExist: true }).absolutePath);
  }

  private resolve(relativePath: string, options: { allowRoot?: boolean; mustExist: boolean }) {
    const segments = relativePath === "" && options.allowRoot ? [] : safeSegments(relativePath);
    let current = this.root;
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]);
      const isTarget = index === segments.length - 1;
      if (!fs.existsSync(current)) {
        if (!isTarget || options.mustExist) throw new RepositoryFileError("REPOSITORY_FILE_NOT_FOUND", "Repository path does not exist.");
        continue;
      }
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new RepositoryFileError("REPOSITORY_PATH_FORBIDDEN", "Symbolic links are outside the repository file boundary.");
      if (!isTarget && !stat.isDirectory()) throw new RepositoryFileError("REPOSITORY_PATH_INVALID", "A parent path is not a directory.");
    }
    if (!withinRoot(current, this.root) || !withinRoot(current, this.boundaryRoot)) {
      throw new RepositoryFileError("REPOSITORY_PATH_FORBIDDEN", "Path escapes the instance workspace boundary.");
    }
    return { absolutePath: current };
  }

  private kind(absolutePath: string, stat: fs.Stats) {
    if (stat.isSymbolicLink()) return "symlink" as const;
    if (stat.isFile()) return "file" as const;
    if (stat.isDirectory()) {
      const dotGit = path.join(absolutePath, ".git");
      if (fs.existsSync(dotGit)) return fs.lstatSync(dotGit).isFile() ? "submodule" as const : "nested-repository" as const;
      return "directory" as const;
    }
    return "special" as const;
  }

  private assertRegularFile(absolutePath: string, stat: fs.Stats) {
    if (!stat.isFile()) throw new RepositoryFileError("REPOSITORY_FILE_UNSUPPORTED", `Only regular files can be edited: ${absolutePath}.`);
  }
}

export function validateRepositoryRelativePath(relativePath: string) {
  if (!relativePath || relativePath.includes("\0") || path.isAbsolute(relativePath) || relativePath.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(relativePath)) {
    throw new RepositoryFileError("REPOSITORY_PATH_INVALID", "Path must be repository-relative.");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git")) {
    throw new RepositoryFileError("REPOSITORY_PATH_INVALID", "Path contains a forbidden segment.");
  }
  return segments;
}

const safeSegments = validateRepositoryRelativePath;

function withinRoot(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function textBuffer(content: string, maxBytes: number) {
  if (content.includes("\0")) throw new RepositoryFileError("REPOSITORY_FILE_BINARY", "Text content cannot contain NUL bytes.");
  const buffer = Buffer.from(content, "utf8");
  if (buffer.length > maxBytes) throw new RepositoryFileError("REPOSITORY_FILE_TOO_LARGE", `File exceeds ${maxBytes} bytes.`);
  return buffer;
}

function fileMode(stat: fs.Stats) {
  return { executable: Boolean(stat.mode & 0o111), gitMode: stat.mode & 0o111 ? "100755" as const : "100644" as const };
}

function fileVersion(buffer: Buffer, stat: fs.Stats) {
  return `version:${crypto.createHash("sha256").update(buffer).update(String(stat.mode & 0o777)).digest("hex")}`;
}

function directoryVersion(entries: RepositoryDirectoryListing["entries"]) {
  return `snapshot:${crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex")}`;
}
