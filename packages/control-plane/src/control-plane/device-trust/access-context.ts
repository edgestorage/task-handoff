export type CloudDeviceAccessContext = {
  bindingId: string;
  accountId: string;
  ownerAccountId: string;
  accessMode: "owner" | "shared";
  cloudAccessRoleId: string;
  devicePublicKey: string;
  shareGrantId?: string;
};
