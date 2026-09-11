import fs from "node:fs";
import { ControlPlaneSecretBox } from "../auth/secret-box.ts";

// Compatibility for v0.0.28: this adapter can only open an existing legacy
// keystore. It never creates a key and is not available to domain services.
export class LegacyControlPlaneSecretReader {
  private readonly secrets: ControlPlaneSecretBox;

  constructor(keyPath: string, domain: string) {
    if (!fs.existsSync(keyPath)) {
      throw Object.assign(new Error(`Legacy ${domain} encryption key is missing.`), {
        code: "CONTROL_PLANE_LEGACY_KEYSTORE_MISSING",
        statusCode: 500,
        details: { domain },
      });
    }
    this.secrets = new ControlPlaneSecretBox(keyPath);
    this.secrets.init();
  }

  open(ciphertext: string) {
    return this.secrets.open(ciphertext);
  }
}
