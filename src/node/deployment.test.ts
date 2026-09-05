import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import conformancePackage from "@layervai/qurl-conformance";
import { loadPortalDeployment } from "./deployment.js";

type Qv2Vectors = {
  classes: {
    transport: {
      vectors: Array<{ name: string; canonical_fragment?: string }>;
    };
  };
};
type IssuerVectors = { issuer: { kid: string; spki_der_b64: string } };

function deploymentJson(): string {
  const qv2 = conformancePackage.qv2Vectors() as Qv2Vectors;
  const vector = qv2.classes.transport.vectors.find(
    (candidate) => candidate.name === "accept_valid_qv2_round_trip",
  );
  if (!vector?.canonical_fragment) throw new Error("shared complete qv2 vector is missing");
  const claims = JSON.parse(
    Buffer.from(vector.canonical_fragment.split(".")[1], "base64url").toString("utf8"),
  ) as { cell_public_key_b64: string };
  const issuer = (conformancePackage.issuerSignatureVectors() as IssuerVectors).issuer;
  return JSON.stringify({
    issuers: [{ kid: issuer.kid, spki_der_b64: issuer.spki_der_b64 }],
    cells: [
      {
        cell_id: "vector-cell",
        host: "cell.example.test",
        port: 443,
        server_public_key_b64: claims.cell_public_key_b64,
      },
    ],
  });
}

afterEach(() => vi.unstubAllEnvs());

describe("native deployment loading", () => {
  it("accepts strict inline QURL_DEPLOYMENT JSON", () => {
    vi.stubEnv("QURL_DEPLOYMENT", deploymentJson());
    const deployment = loadPortalDeployment();
    expect(deployment.issuers.size).toBe(1);
    expect(deployment.cells.size).toBe(1);
  });

  it("accepts a Go-compatible QURL_DEPLOYMENT file path", () => {
    const directory = mkdtempSync(join(tmpdir(), "qurl-typescript-deployment-"));
    const path = join(directory, "deployment.json");
    try {
      writeFileSync(path, deploymentJson(), { mode: 0o600 });
      vi.stubEnv("QURL_DEPLOYMENT", path);
      const deployment = loadPortalDeployment();
      expect(deployment.issuers.size).toBe(1);
      expect(deployment.cells.size).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown and duplicate trust fields", () => {
    vi.stubEnv("QURL_DEPLOYMENT", deploymentJson().replace('{"issuers":', '{"extra":1,"issuers":'));
    expect(() => loadPortalDeployment()).toThrow("unknown field");
    vi.stubEnv(
      "QURL_DEPLOYMENT",
      deploymentJson().replace('{"issuers":', '{"issuers":[],"issuers":'),
    );
    expect(() => loadPortalDeployment()).toThrow("duplicate");
  });
});
