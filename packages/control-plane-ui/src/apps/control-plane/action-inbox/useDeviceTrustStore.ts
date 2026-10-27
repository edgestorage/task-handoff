import { sharedControlPlaneClient } from "../../../api/sharedClient";
import { createDeviceTrustStore } from "./deviceTrustStore.ts";

const sharedDeviceTrustStore = createDeviceTrustStore(sharedControlPlaneClient.deviceTrust);

export function useDeviceTrustStore() {
  return sharedDeviceTrustStore;
}
