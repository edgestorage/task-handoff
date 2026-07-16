export type AppKind = "tty" | "gui" | "web";
export type AppSessionStatus = "created" | "running" | "stopping" | "stopped" | "exited" | "failed";
export type AppDisplayTarget = {
  mode: "isolated" | "shared";
  id?: string;
  autoCreate?: boolean;
};

export type AppCatalogItem = {
  id: string;
  name: string;
  kind: AppKind;
  description?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  display?: {
    width?: number;
    height?: number;
    depth?: number;
  };
  defaultDisplayTarget?: AppDisplayTarget;
  automation?: {
    type: "cdp";
    portArg?: string;
    endpointPath?: string;
  };
  web?: {
    portArg?: string;
    readyPath?: string;
  };
};

export type ManagedAppDetectionRule = {
  type: "launcher-executable" | "executable";
  command?: string;
  versionArgs?: string[];
};

export type ManagedAppRecipePlatform = "linux" | "darwin" | "win32" | "freebsd" | "openbsd" | "aix" | "sunos";
export type ManagedAppRecipeArch = "x64" | "arm64" | "arm" | "ia32" | "ppc64" | "s390x" | "riscv64";
export type ManagedAppRecipePrivilege = "user" | "passwordless-sudo" | "root";

type ManagedAppRecipeConstraint = {
  platforms: ManagedAppRecipePlatform[];
  arches?: ManagedAppRecipeArch[];
  privilege?: ManagedAppRecipePrivilege;
};

export type BundledInstallRecipe = ManagedAppRecipeConstraint & {
  type: "bundled";
};

export type SystemPackageInstallRecipe = ManagedAppRecipeConstraint & {
  type: "system-package";
  installer: "apt" | "dnf" | "brew";
  packages: string[];
};

export type ArchiveInstallRecipe = ManagedAppRecipeConstraint & {
  type: "archive";
  url: string;
  sha256: string;
  format: "tar.gz" | "tar.xz" | "zip";
  installRoot: string;
};

export type InstallRecipe = BundledInstallRecipe | SystemPackageInstallRecipe | ArchiveInstallRecipe;

export type ManagedAppDefinition = {
  launcher: AppCatalogItem;
  detection: ManagedAppDetectionRule[];
  distribution: {
    recipes: InstallRecipe[];
  };
};

export type ManagedAppDetectionResult = {
  state: "installed" | "not-installed" | "broken";
  executablePaths: string[];
  version?: string;
};

export type AppLaunchOptions = {
  title?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  display?: {
    width?: number;
    height?: number;
    depth?: number;
  };
  displayTarget?: AppDisplayTarget;
};

export type AppSession = {
  id: string;
  appId: string;
  title: string;
  kind: AppKind;
  status: AppSessionStatus;
  createdAt: string;
  updatedAt: string;
  launch?: AppLaunchOptions;
  tty?: {
    webPath: string;
    shell: string;
    cwd: string;
    mode?: "pty" | "claude-attach";
  };
  display?: {
    display: string;
    mode?: "isolated" | "shared";
    displaySessionId?: string;
    width: number;
    height: number;
    depth: number;
    xPid?: number;
    wmPid?: number;
    compositorPid?: number;
    xauthority?: string;
  };
  vnc?: {
    backend?: "novnc" | "kasmvnc";
    host: string;
    port: number;
    websockifyPort?: number;
    webPath: string;
    noVncPath: string;
  };
  web?: {
    host: string;
    port: number;
    webPath: string;
    readyPath?: string;
  };
  automation?: {
    type: "cdp";
    endpoint: string;
    port: number;
  };
  process?: {
    pid?: number;
    command: string;
    exitCode?: number | null;
    signal?: string | null;
  };
  ai?: {
    agent?: "codex" | "claude" | string;
    activeThreadId?: string;
    threadIds?: string[];
    appServer?: {
      transport: "unix";
      endpoint: string;
      socketPath: string;
      proxyEndpoint?: string;
      proxyPort?: number;
      pid?: number;
      command: string;
      args: string[];
      logPath?: string;
      status: "starting" | "running" | "exited" | "failed";
      exitCode?: number | null;
      signal?: string | null;
    };
    claude?: {
      short: string;
      controlSock: string;
      providerSessionId?: string;
      pid?: number;
      cwd?: string;
      state?: string;
      tempo?: string;
      cliVersion?: string;
      source?: string;
    };
  };
  paths: {
    sessionDir: string;
    logDir: string;
  };
  error?: {
    code: string;
    message: string;
  };
};

export type AppAutomationStatus = {
  sessionId: string;
  type: "cdp";
  endpoint: string;
  port: number;
  ready: boolean;
  browser?: string;
  protocolVersion?: string;
  webSocketDebuggerUrl?: string;
  error?: {
    code: string;
    message: string;
  };
};
