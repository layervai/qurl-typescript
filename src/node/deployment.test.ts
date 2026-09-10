import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import conformancePackage from "@layervai/qurl-conformance";
import { deploymentTesting, loadPortalDeployment, loadDeploymentHub } from "./deployment.js";

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

  it("rejects a non-regular deployment path before reading it", () => {
    const directory = mkdtempSync(join(tmpdir(), "qurl-typescript-deployment-"));
    try {
      vi.stubEnv("QURL_DEPLOYMENT", directory);
      expect(() => loadPortalDeployment()).toThrow("regular file");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects an oversized deployment file before materializing its contents", () => {
    const directory = mkdtempSync(join(tmpdir(), "qurl-typescript-deployment-"));
    const path = join(directory, "deployment.json");
    try {
      writeFileSync(path, Buffer.alloc(1_048_577));
      vi.stubEnv("QURL_DEPLOYMENT", path);
      expect(() => loadPortalDeployment()).toThrow("1 MiB limit");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a deployment file that grows after its bounded read", () => {
    const close = vi.fn();
    const read = vi
      .fn()
      .mockImplementationOnce(
        (_descriptor: number, buffer: Buffer, offset: number, _length: number) => {
          buffer[offset] = 0x7b;
          return 1;
        },
      )
      .mockImplementationOnce(
        (_descriptor: number, buffer: Buffer, offset: number, _length: number) => {
          buffer[offset] = 0x78;
          return 1;
        },
      );
    expect(() =>
      deploymentTesting.readBoundedDeploymentFile("deployment.json", {
        open: () => 17,
        stat: () => ({ size: 1, isFile: () => true }),
        read,
        close,
      }),
    ).toThrow("changed while it was read");
    expect(read).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledWith(17);
  });

  it("rejects a deployment file that shrinks during its bounded read", () => {
    const close = vi.fn();
    const read = vi
      .fn()
      .mockImplementationOnce(
        (_descriptor: number, buffer: Buffer, offset: number, _length: number) => {
          buffer[offset] = 0x7b;
          return 1;
        },
      )
      .mockReturnValueOnce(0);
    expect(() =>
      deploymentTesting.readBoundedDeploymentFile("deployment.json", {
        open: () => 19,
        stat: () => ({ size: 2, isFile: () => true }),
        read,
        close,
      }),
    ).toThrow("changed while it was read");
    expect(read).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledWith(19);
  });

  it.each([
    ["mixed alphabets", "+-", "mixes base64 alphabets"],
    ["invalid shape", "a*", "not valid base64"],
    ["noncanonical trailing bits", "AB", "not canonical base64"],
  ])("rejects %s in deployment base64", (_name, value, message) => {
    expect(() => deploymentTesting.decodeFlexibleBase64(value, "test key")).toThrow(message);
  });

  it("accepts canonical padded and raw deployment base64", () => {
    expect(deploymentTesting.decodeFlexibleBase64("AQ==", "test key")).toEqual(new Uint8Array([1]));
    expect(deploymentTesting.decodeFlexibleBase64("AQ", "test key")).toEqual(new Uint8Array([1]));
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

describe("producer Hub deployment loading", () => {
  it.each([undefined, " ", "{}", '{"hub":null}', '{"hub":{},"unknown":true}'])(
    "refuses missing or malformed Hub configuration %s",
    (configured) => {
      vi.stubEnv("QURL_DEPLOYMENT", configured);
      expect(() => loadDeploymentHub()).toThrow("no producer Hub");
    },
  );
  it("loads the same Hub from inline JSON and a deployment file", () => {
    const dir = mkdtempSync(join(tmpdir(), "qurl-hub-test-"));
    const path = join(dir, "deployment.json");
    const deployment = JSON.parse(deploymentJson());
    const { host, port, server_public_key_b64 } = deployment.cells[0];
    const hub = {
      host,
      port,
      server_public_key_b64: Buffer.from(server_public_key_b64, "base64url").toString("base64"),
    };
    const raw = JSON.stringify({ ...deployment, hub });
    try {
      writeFileSync(path, raw, { mode: 0o600 });
      for (const configured of [raw, path]) {
        vi.stubEnv("QURL_DEPLOYMENT", configured);
        expect(loadDeploymentHub()).toEqual({ ...hub, port: 443n });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
