import type { ControlPlaneDatabase } from "../persistence/database/index.ts";
import type {
  ControlPlaneCloudDeviceTrustRepository,
  ControlPlaneDatabaseRepository,
} from "../persistence/database/repository.ts";

export type { ControlPlaneCloudDeviceTrustRepository } from "../persistence/database/repository.ts";
export type { CloudDeviceAccessContext } from "./access-context.ts";

export type CloudDeviceTrustRoleRepository = Pick<ControlPlaneDatabaseRepository, "roles">;

export type ControlPlaneDeviceTrustTransaction = {
  readonly roles: CloudDeviceTrustRoleRepository["roles"];
  readonly cloudDeviceTrust: ControlPlaneCloudDeviceTrustRepository;
};

export type ControlPlaneDeviceTrustStore = {
  transaction<T>(operation: (repository: ControlPlaneDeviceTrustTransaction) => Promise<T>): Promise<T>;
};

export function createControlPlaneDeviceTrustStore(
  database: Pick<ControlPlaneDatabase, "transaction">,
): ControlPlaneDeviceTrustStore {
  return {
    transaction: (operation) => database.transaction((repository) => operation({
      roles: repository.roles,
      cloudDeviceTrust: repository.cloudDeviceTrust,
    })),
  };
}
