import type { ControlPlaneMessages } from "../en-US/index.ts";
import { agents } from "./agents.ts";
import { auth } from "./auth.ts";
import { cliAuthorize } from "./cliAuthorize.ts";
import { common } from "./common.ts";
import { errors } from "./errors.ts";
import { instances } from "./instances.ts";
import { navigation } from "./navigation.ts";
import { repository } from "./repository.ts";
import { sessions } from "./sessions.ts";
import { settings } from "./settings.ts";
import { stories } from "./stories.ts";
import { triggers } from "./triggers.ts";

export const zhCN = {
  agents,
  auth,
  cliAuthorize,
  common,
  errors,
  instances,
  navigation,
  repository,
  sessions,
  settings,
  stories,
  triggers,
} as const satisfies ControlPlaneMessages;
