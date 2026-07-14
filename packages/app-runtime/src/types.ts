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
