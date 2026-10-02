import { z } from "zod";
import {
  ControlPlaneExternalIdentityApprovalSummarySchema,
  ControlPlaneIdentityProviderSummarySchema,
  ControlPlanePermissionDescriptorSchema,
  ControlPlaneRoleSummarySchema,
  ControlPlaneUserDetailSchema,
} from "@task-handoff/protocol/control-plane-access";
import { inputOf, looseOutput, type CliLeaf } from "./definition.ts";
import {
  userAccess,
  userCreate,
  userExternalIdentityApprove,
  userExternalIdentityList,
  userExternalIdentityReject,
  userIdentityProviderCreate,
  userIdentityProviderList,
  userIdentityProviderRemove,
  userIdentityProviderUpdate,
  userPasswordReset,
  userPermissionList,
  userRoleCreate,
  userRoleList,
  userRoleRemove,
  userRoleUpdate,
  userUpdate,
} from "../commands/user.ts";

const configOption = { flags: "--config <file>", description: "Request body as a JSON file (Control Plane wire body)" };
const loose = { output: looseOutput, outputPinned: false } as const;

export const userAccessLeaves: readonly CliLeaf[] = [
  {
    id: "user create", group: "user", name: "create", stage: "B", write: true, summary: "Create a local user",
    options: [configOption], input: inputOf({ config: z.string() }), output: ControlPlaneUserDetailSchema, handler: userCreate,
  },
  {
    id: "user update", group: "user", name: "update", stage: "B", write: true, summary: "Update a user",
    args: [{ name: "userId", description: "User ID", required: true }],
    options: [configOption], input: inputOf({ userId: z.string(), config: z.string() }), output: ControlPlaneUserDetailSchema, handler: userUpdate,
  },
  {
    id: "user access", group: "user", name: "access", stage: "B", write: true, summary: "Replace a user's access grant",
    args: [{ name: "userId", description: "User ID", required: true }],
    options: [configOption], input: inputOf({ userId: z.string(), config: z.string() }), output: ControlPlaneUserDetailSchema, handler: userAccess,
  },
  {
    id: "user password-reset", group: "user", name: "password-reset", stage: "B", write: true, summary: "Reset a user's password (password is read from stdin)",
    args: [{ name: "userId", description: "User ID", required: true }],
    options: [{ flags: "--require-change", description: "Require the user to change the password at next sign-in" }],
    input: inputOf({ userId: z.string(), requireChange: z.boolean().optional() }), output: looseOutput, outputPinned: false, handler: userPasswordReset,
  },
  {
    id: "user role list", group: "user", name: "role list", stage: "B", summary: "List roles",
    input: inputOf({}), output: z.array(ControlPlaneRoleSummarySchema), handler: userRoleList,
  },
  {
    id: "user role create", group: "user", name: "role create", stage: "B", write: true, summary: "Create a custom role",
    options: [configOption], input: inputOf({ config: z.string() }), output: ControlPlaneRoleSummarySchema, handler: userRoleCreate,
  },
  {
    id: "user role update", group: "user", name: "role update", stage: "B", write: true, summary: "Update a role",
    args: [{ name: "roleId", description: "Role ID", required: true }],
    options: [configOption], input: inputOf({ roleId: z.string(), config: z.string() }), output: ControlPlaneRoleSummarySchema, handler: userRoleUpdate,
  },
  {
    id: "user role remove", group: "user", name: "role remove", stage: "B", write: true, summary: "Archive a role",
    args: [{ name: "roleId", description: "Role ID", required: true }],
    input: inputOf({ roleId: z.string() }), output: ControlPlaneRoleSummarySchema, handler: userRoleRemove,
  },
  {
    id: "user permission list", group: "user", name: "permission list", stage: "B", summary: "List permission descriptors",
    input: inputOf({}), output: z.array(ControlPlanePermissionDescriptorSchema), handler: userPermissionList,
  },
  {
    id: "user identity-provider list", group: "user", name: "identity-provider list", stage: "B", summary: "List identity providers",
    input: inputOf({}), output: z.array(ControlPlaneIdentityProviderSummarySchema), handler: userIdentityProviderList,
  },
  {
    id: "user identity-provider create", group: "user", name: "identity-provider create", stage: "B", write: true, summary: "Create an identity provider",
    options: [configOption], input: inputOf({ config: z.string() }), output: ControlPlaneIdentityProviderSummarySchema, handler: userIdentityProviderCreate,
  },
  {
    id: "user identity-provider update", group: "user", name: "identity-provider update", stage: "B", write: true, summary: "Update an identity provider",
    args: [{ name: "providerId", description: "Identity provider ID", required: true }],
    options: [configOption], input: inputOf({ providerId: z.string(), config: z.string() }), output: ControlPlaneIdentityProviderSummarySchema, handler: userIdentityProviderUpdate,
  },
  {
    id: "user identity-provider remove", group: "user", name: "identity-provider remove", stage: "B", write: true, summary: "Remove an identity provider",
    args: [{ name: "providerId", description: "Identity provider ID", required: true }],
    input: inputOf({ providerId: z.string() }), output: z.looseObject({ deleted: z.boolean() }), handler: userIdentityProviderRemove,
  },
  {
    id: "user external-identity list", group: "user", name: "external-identity list", stage: "B", summary: "List pending external identity approvals",
    input: inputOf({}), output: z.array(ControlPlaneExternalIdentityApprovalSummarySchema), handler: userExternalIdentityList,
  },
  {
    id: "user external-identity approve", group: "user", name: "external-identity approve", stage: "B", write: true, summary: "Approve an external identity binding",
    args: [{ name: "approvalId", description: "Approval ID", required: true }],
    options: [{ flags: "--config <file>", description: "Approval request JSON (optional)" }],
    input: inputOf({ approvalId: z.string(), config: z.string().optional() }), output: ControlPlaneUserDetailSchema, handler: userExternalIdentityApprove,
  },
  {
    id: "user external-identity reject", group: "user", name: "external-identity reject", stage: "B", write: true, summary: "Reject an external identity binding",
    args: [{ name: "approvalId", description: "Approval ID", required: true }],
    input: inputOf({ approvalId: z.string() }), output: looseOutput, outputPinned: false, handler: userExternalIdentityReject,
  },
];
