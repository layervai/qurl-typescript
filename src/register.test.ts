import { describe, it, expect } from "vitest";
import { registerAgent, bootstrapAgent } from "./register.js";
import { MemoryAgentStateStore } from "./agent-state.js";
import type { AgentState } from "./agent-state.js";
import {
  OTPPendingError,
  OTPIncorrectError,
  OTPExpiredError,
  RegisterConfigError,
  RegisterKeyRejectedError,
  AgentIdentityConflictError,
  RegistrationRateLimitedError,
  RegistrationInvalidInputError,
  RegistrationRetryLaterError,
  BootstrapSetupKeyConsumedError,
  BootstrapConfigError,
  DeviceCredentialMissingError,
  NoAccountEmailError,
  RegistrationDenyError,
  RegistrationTransportError,
  ERROR_CODE_REGISTER_TRANSPORT,
  QURLError,
} from "./errors.js";
import { RegisterHarness, seededRandomBytes } from "./__tests__/register-harness.js";

// registerAgent tested end to end against the RegisterHarness (a fake
// qurl-service + a fake NHP relay sharing the vendored crypto), mirroring the Go
// register_test.go scenarios: the two enrollment paths, the two-phase OTP flow,
// re-entrant OTP, completion, error mapping, the fast path, and the server_id
// integrity check.

function baseOpts(h: RegisterHarness, extra: Record<string, unknown> = {}) {
  return {
    baseUrl: h.apiBase(),
    fetch: h.fetch,
    randomBytes: seededRandomBytes(1),
    now: () => 1_700_000_000_000,
    ...extra,
  };
}

describe("registerAgent — bootstrap path (PATH A)", () => {
  it("enrolls in one call and returns a ready client", async () => {
    const h = new RegisterHarness({
      keyKind: "bootstrap",
      expectedBearer: "lv_bootstrap_key",
      expectCredential: "lv_bootstrap_key",
    });

    const { client, state } = await registerAgent("lv_bootstrap_key", h.store, baseOpts(h));

    expect(client).toBeDefined();
    expect(state.registered_at).toBeTruthy();
    expect(state.device_api_key).toBe("lv_device_secret");
    expect(state.schema_version).toBe(2);
    expect(state.agent_id).toMatch(/^agent-/);
    expect(h.completionCalls).toBe(1);
    expect(h.regCount).toBe(1);
    expect(h.otpSends).toBe(0);
  });

  it("fast path: no network once registered", async () => {
    const h = new RegisterHarness({ expectedBearer: "lv_bootstrap_key" });
    await registerAgent("lv_bootstrap_key", h.store, baseOpts(h));
    const infoAfterFirst = h.infoCalls;

    const { client } = await registerAgent("lv_bootstrap_key", h.store, baseOpts(h));
    expect(client).toBeDefined();
    expect(h.infoCalls).toBe(infoAfterFirst); // zero extra registration-info calls
  });

  it("fast path fails closed when a registered state has no device key", async () => {
    // A registered state with a valid keypair but no device_api_key: the fast
    // path must fail closed (the credential is issued once and unrecoverable).
    const priv = seededRandomBytes(3)(32);
    const { x25519 } = await import("@noble/curves/ed25519.js");
    const state: AgentState = {
      private_key_b64: btoa(String.fromCharCode(...priv)),
      public_key_b64: btoa(String.fromCharCode(...x25519.getPublicKey(priv))),
      agent_id: "agent-x",
      registered_at: new Date().toISOString(),
      nhp_server_peer: {
        public_key_b64: btoa("\0".repeat(32)),
        host: "h",
        port: 1,
        expire_time: 0,
      },
    };
    const store = new MemoryAgentStateStore(state);
    await expect(
      registerAgent("lv_key", store, { now: () => 1_700_000_000_000 }),
    ).rejects.toBeInstanceOf(DeviceCredentialMissingError);
  });
});

describe("registerAgent — account path (PATH B) two-phase OTP", () => {
  it("phase 1 sends the code and throws OTPPendingError; phase 2 completes", async () => {
    const h = new RegisterHarness({
      keyKind: "account",
      maskedEmail: "j***@x.com",
      expectedBearer: "lv_account_key",
      expectCredential: "123456",
    });
    const store = h.store;

    // Phase 1: no code -> OTP sent, otp_pending, OTPPendingError.
    const err = await registerAgent("lv_account_key", store, baseOpts(h)).catch((e) => e);
    expect(err).toBeInstanceOf(OTPPendingError);
    expect((err as OTPPendingError).maskedEmail).toBe("j***@x.com");
    expect(err).toBeInstanceOf(QURLError); // still an SDK error
    expect(h.otpSends).toBe(1);
    expect(store.state?.otp_requested_at).toBeTruthy();
    expect(store.state?.registered_at).toBeFalsy();

    // Phase 2: supply the code -> REG -> completion -> client.
    const { client, state } = await registerAgent(
      "lv_account_key",
      store,
      baseOpts(h, { otp: "123456" }),
    );
    expect(client).toBeDefined();
    expect(state.registered_at).toBeTruthy();
    expect(state.device_api_key).toBe("lv_device_secret");
    expect(state.otp_requested_at).toBeFalsy();
    expect(h.regCount).toBe(1);
  });

  it("does not re-send within the resend cooldown", async () => {
    const h = new RegisterHarness({ keyKind: "account", maskedEmail: "j***@x.com" });
    const opts = baseOpts(h);
    await expect(registerAgent("lv_account_key", h.store, opts)).rejects.toBeInstanceOf(
      OTPPendingError,
    );
    await expect(registerAgent("lv_account_key", h.store, opts)).rejects.toBeInstanceOf(
      OTPPendingError,
    );
    expect(h.otpSends).toBe(1); // no resend within cooldown
  });

  it("re-sends after the cooldown elapses (re-entrant across two calls, one store)", async () => {
    const h = new RegisterHarness({ keyKind: "account", maskedEmail: "j***@x.com" });
    let now = 1_700_000_000_000;
    const clk = () => now;

    await expect(
      registerAgent("lv_account_key", h.store, baseOpts(h, { now: clk })),
    ).rejects.toBeInstanceOf(OTPPendingError);
    expect(h.otpSends).toBe(1);

    // Past the cooldown, the resume probe reports not-yet-registered (default,
    // since no REG succeeded), then the no-code branch re-sends.
    now += 60_000 + 1_000;
    await expect(
      registerAgent("lv_account_key", h.store, baseOpts(h, { now: clk })),
    ).rejects.toBeInstanceOf(OTPPendingError);
    expect(h.otpSends).toBe(2);
  });

  it("persists otp_requested_at BEFORE sending (anti-spam): a persist failure emits no code", async () => {
    const h = new RegisterHarness({ keyKind: "account", maskedEmail: "j***@x.com" });
    // Fail the save that records otp_pending (first save carrying otp_requested_at).
    h.store.failWhen = (s) => s.otp_requested_at !== undefined && s.otp_requested_at !== null;
    h.store.failsLeft = 1;
    const saveErr = new Error("injected transient store write failure");
    h.store.failError = saveErr;

    // First attempt: the otp_pending persist fails, no email is sent.
    await expect(registerAgent("lv_account_key", h.store, baseOpts(h))).rejects.toBe(saveErr);
    expect(h.otpSends).toBe(0);
    expect(h.store.state?.otp_requested_at).toBeFalsy();

    // Retry: the save now succeeds, exactly one code is dispatched, then it pauses.
    await expect(registerAgent("lv_account_key", h.store, baseOpts(h))).rejects.toBeInstanceOf(
      OTPPendingError,
    );
    expect(h.otpSends).toBe(1); // no duplicate across failure + retry
  });

  it("a fresh-store static otp pauses instead of a doomed REG", async () => {
    const h = new RegisterHarness({ keyKind: "account", maskedEmail: "j***@x.com" });
    await expect(
      registerAgent("lv_account_key", h.store, baseOpts(h, { otp: "staleCode" })),
    ).rejects.toBeInstanceOf(OTPPendingError);
    expect(h.otpSends).toBe(1); // code emailed for the next run
    expect(h.regCount).toBe(0); // no doomed REG

    // Resume with the now-valid code completes.
    h.cfg.expectCredential = "realCode";
    const { client } = await registerAgent(
      "lv_account_key",
      h.store,
      baseOpts(h, { otp: "realCode" }),
    );
    expect(client).toBeDefined();
    expect(h.regCount).toBe(1);
  });

  it("otpProvider completes on a fresh store in one call (email requested, then fetched)", async () => {
    const h = new RegisterHarness({
      keyKind: "account",
      maskedEmail: "j***@x.com",
      expectCredential: "778899",
    });
    let called = false;
    const provider = () => {
      called = true;
      return "778899";
    };
    const { client, state } = await registerAgent(
      "lv_account_key",
      h.store,
      baseOpts(h, { otpProvider: provider }),
    );
    expect(called).toBe(true);
    expect(client).toBeDefined();
    expect(h.otpSends).toBe(1); // email requested before the provider fetches
    expect(h.regCount).toBe(1);
    expect(state.registered_at).toBeTruthy();
  });

  it("fails fast when the account key has no email on file", async () => {
    const h = new RegisterHarness({ keyKind: "account", maskedEmail: "" });
    await expect(registerAgent("lv_account_key", h.store, baseOpts(h))).rejects.toBeInstanceOf(
      NoAccountEmailError,
    );
    expect(h.otpSends).toBe(0);
  });

  it("crash-recovery probe self-heals a no-code resume against an enrolled device", async () => {
    const h = new RegisterHarness({ keyKind: "account", maskedEmail: "j***@x.com" });
    // Phase 1 to reach otp_pending.
    await expect(registerAgent("lv_account_key", h.store, baseOpts(h))).rejects.toBeInstanceOf(
      OTPPendingError,
    );
    // Model the crash: a prior REG succeeded server-side but completion never ran.
    h.enrolled = true;
    const regsBefore = h.regCount;

    const { client, state } = await registerAgent("lv_account_key", h.store, baseOpts(h));
    expect(client).toBeDefined();
    expect(h.regCount).toBe(regsBefore); // no REG: the probe finished the run
    expect(state.registered_at).toBeTruthy();
    expect(state.device_api_key).toBe("lv_device_secret");
  });

  it("resume probe skips the otpProvider when it can finish", async () => {
    const h = new RegisterHarness({ keyKind: "account", maskedEmail: "j***@x.com" });
    await expect(registerAgent("lv_account_key", h.store, baseOpts(h))).rejects.toBeInstanceOf(
      OTPPendingError,
    );
    h.enrolled = true;
    let providerCalls = 0;
    const provider = () => {
      providerCalls++;
      return "999000";
    };
    const { client } = await registerAgent(
      "lv_account_key",
      h.store,
      baseOpts(h, { otpProvider: provider }),
    );
    expect(client).toBeDefined();
    expect(providerCalls).toBe(0);
    expect(h.regCount).toBe(0);
  });
});

describe("registerAgent — RAK error mapping over the wire", () => {
  const cases: Array<{ name: string; code: string; ctor: new (...a: never[]) => Error }> = [
    { name: "wrong otp", code: "52100", ctor: OTPIncorrectError },
    { name: "expired otp", code: "52101", ctor: OTPExpiredError },
    { name: "identity conflict", code: "52103", ctor: AgentIdentityConflictError },
    { name: "rate limited", code: "52104", ctor: RegistrationRateLimitedError },
    { name: "invalid input", code: "52109", ctor: RegistrationInvalidInputError },
  ];
  for (const c of cases) {
    it(`account path errCode ${c.code} -> ${c.ctor.name}`, async () => {
      const h = new RegisterHarness({
        keyKind: "account",
        maskedEmail: "j***@x.com",
        rakErrCode: c.code,
        rakErrMsg: "scripted denial",
      });
      // Prime otp_pending so the resume (with the otp option) actually sends REG.
      await expect(registerAgent("lv_account_key", h.store, baseOpts(h))).rejects.toBeInstanceOf(
        OTPPendingError,
      );

      const err = await registerAgent(
        "lv_account_key",
        h.store,
        baseOpts(h, { otp: "000000" }),
      ).catch((e) => e);
      expect(err).toBeInstanceOf(c.ctor);
      // A denied REG must not persist a registered state.
      expect(h.store.state?.registered_at).toBeFalsy();
      expect(h.store.state?.device_api_key).toBeFalsy();
    });
  }

  it("bootstrap path 52100 maps to key-rejected (path-dependent)", async () => {
    const h = new RegisterHarness({ keyKind: "bootstrap", rakErrCode: "52100" });
    const err = await registerAgent("lv_bad_bootstrap", h.store, baseOpts(h)).catch((e) => e);
    expect(err).toBeInstanceOf(RegisterKeyRejectedError);
    expect(err).not.toBeInstanceOf(OTPIncorrectError);
  });

  it("bootstrap path 52108 maps to setup-key-consumed", async () => {
    const h = new RegisterHarness({ keyKind: "bootstrap", rakErrCode: "52108" });
    await expect(registerAgent("lv_used_setup", h.store, baseOpts(h))).rejects.toBeInstanceOf(
      BootstrapSetupKeyConsumedError,
    );
  });

  it("unknown RAK code becomes a RegistrationDenyError carrying the raw fields", async () => {
    const h = new RegisterHarness({
      keyKind: "bootstrap",
      rakErrCode: "59999",
      rakErrMsg: "brand new failure",
    });
    const err = await registerAgent("lv_key", h.store, baseOpts(h)).catch((e) => e);
    expect(err).toBeInstanceOf(RegistrationDenyError);
    expect((err as RegistrationDenyError).errCode).toBe("59999");
    expect((err as RegistrationDenyError).errMsg).toBe("brand new failure");
  });

  it("a REG answered with an overload cookie-challenge maps to retry-later", async () => {
    const h = new RegisterHarness({ keyKind: "bootstrap", replyREGWithCOK: true });
    const err = await registerAgent("lv_key", h.store, baseOpts(h)).catch((e) => e);
    expect(err).toBeInstanceOf(RegistrationRetryLaterError);
    expect(err).not.toBeInstanceOf(RegisterConfigError);
  });
});

describe("registerAgent — completion HTTP mapping", () => {
  it("409 device_key_already_issued -> DeviceCredentialMissingError", async () => {
    const h = new RegisterHarness({ keyKind: "bootstrap" });
    h.completionStatus = 409;
    h.completionCode = "device_key_already_issued";
    await expect(registerAgent("lv_key", h.store, baseOpts(h))).rejects.toBeInstanceOf(
      DeviceCredentialMissingError,
    );
  });

  it("a bare 409 (no structured code) is NOT DeviceCredentialMissing", async () => {
    const h = new RegisterHarness({ keyKind: "bootstrap" });
    h.completionStatus = 409;
    h.completionCode = "";
    const err = await registerAgent("lv_key", h.store, baseOpts(h)).catch((e) => e);
    expect(err).not.toBeInstanceOf(DeviceCredentialMissingError);
    expect(err).toBeInstanceOf(QURLError);
    expect((err as QURLError).status).toBe(409);
  });

  it("bootstrap completion setup_key_consumed is path-gated to the bootstrap sentinel", async () => {
    const h = new RegisterHarness({ keyKind: "bootstrap" });
    h.completionStatus = 409;
    h.completionCode = "setup_key_consumed";
    await expect(registerAgent("lv_setup_once", h.store, baseOpts(h))).rejects.toBeInstanceOf(
      BootstrapSetupKeyConsumedError,
    );
  });

  it("account completion setup_key_consumed does NOT surface the bootstrap sentinel", async () => {
    const h = new RegisterHarness({ keyKind: "account", maskedEmail: "j***@x.com" });
    await expect(registerAgent("lv_account_key", h.store, baseOpts(h))).rejects.toBeInstanceOf(
      OTPPendingError,
    );

    // Probe (completion #1) reports not-registered → fall through to REG; the real
    // completion (#2, post-REG) returns 409 setup_key_consumed on the account path.
    let hits = 0;
    h.completionOverride = () => {
      hits++;
      if (hits === 1) return { status: 404, code: "device_not_registered" };
      return { status: 409, code: "setup_key_consumed" };
    };
    const err = await registerAgent(
      "lv_account_key",
      h.store,
      baseOpts(h, { otp: "123456" }),
    ).catch((e) => e);
    expect(err).not.toBeInstanceOf(BootstrapSetupKeyConsumedError);
    expect(err).toBeInstanceOf(QURLError);
    expect((err as QURLError).status).toBe(409);
    expect((err as QURLError).code).toBe("setup_key_consumed");
  });
});

describe("registerAgent — server_id integrity + overrides", () => {
  it("rejects a registration-info server_id that does not match the peer key fingerprint", async () => {
    const h = new RegisterHarness({ keyKind: "bootstrap" });
    // Override registration-info to return a wrong server_id.
    const good = h.fetch;
    h.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url === `${h.apiBase()}/v1/agent/registration-info`) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          json: () =>
            Promise.resolve({
              data: {
                key_kind: "bootstrap",
                key_id: "key_test123",
                nhp_server_peer: h.nhpPeer(),
                relay: { base_url: h.relayUrl(), server_id: "AAAAAAAAAAA" },
                masked_email: "",
              },
            }),
          text: () => Promise.resolve(""),
        } as Response;
      }
      return good(input, init);
    }) as typeof globalThis.fetch;

    const err = await registerAgent("lv_key", h.store, baseOpts(h, { fetch: h.fetch })).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(RegisterConfigError);
    expect((err as Error).message).toMatch(/server_id/);
  });

  it("nhpPeer + relayUrl overrides complete against the same fake server", async () => {
    const h = new RegisterHarness({ keyKind: "bootstrap" });
    const { client } = await registerAgent(
      "lv_key",
      h.store,
      baseOpts(h, {
        nhpPeer: { ...h.nhpPeer(), host: "nhp.override.test", port: 7777 },
        relayUrl: h.relayUrl(),
      }),
    );
    expect(client).toBeDefined();
    expect(h.regCount).toBe(1);
  });

  it("registration-info 401 maps to key-rejected", async () => {
    const h = new RegisterHarness({ keyKind: "bootstrap" });
    const good = h.fetch;
    h.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url === `${h.apiBase()}/v1/agent/registration-info`) {
        return {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          headers: new Headers(),
          json: () => Promise.resolve({ error: { code: "invalid_api_key", detail: "bad key" } }),
          text: () => Promise.resolve(""),
        } as Response;
      }
      return good(input, init);
    }) as typeof globalThis.fetch;
    const err = await registerAgent("lv_bad_key", h.store, baseOpts(h, { fetch: h.fetch })).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(RegisterKeyRejectedError);
    // The cause chains the underlying API error.
    expect((err as RegisterKeyRejectedError).cause).toBeInstanceOf(QURLError);
  });

  it("a transport fault on the HTTPS pre-flight surfaces the retryable transport code, not a config error", async () => {
    const h = new RegisterHarness({ keyKind: "bootstrap" });
    const netErr = new TypeError("fetch failed: ECONNREFUSED");
    h.fetch = (async (input) => {
      const url = typeof input === "string" ? input : (input as URL).toString();
      if (url === `${h.apiBase()}/v1/agent/registration-info`) {
        throw netErr; // DNS/connection/timeout-style transport fault
      }
      throw new Error("unexpected");
    }) as typeof globalThis.fetch;
    const err = await registerAgent("lv_key", h.store, baseOpts(h, { fetch: h.fetch })).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(RegistrationTransportError);
    // Distinct retryable discriminant — NOT the permanent-misconfig config class.
    expect(err).not.toBeInstanceOf(RegisterConfigError);
    expect((err as RegistrationTransportError).code).toBe(ERROR_CODE_REGISTER_TRANSPORT);
    expect((err as RegistrationTransportError).cause).toBe(netErr);
  });
});

describe("registerAgent — REG body metadata + takeover", () => {
  it("takeover + hostname + version ride in the REG usrData", async () => {
    const h = new RegisterHarness({ keyKind: "bootstrap" });
    await registerAgent(
      "lv_key",
      h.store,
      baseOpts(h, { takeover: true, hostname: "host-9", version: "2.0.1" }),
    );
    expect(h.regCount).toBe(1);
    expect(h.lastReg?.usrData?.takeover).toBe(true);
    expect(h.lastReg?.usrData?.hostname).toBe("host-9");
    expect(h.lastReg?.usrData?.version).toBe("2.0.1");
  });

  it("the OTP body carries the API key secret in the sealed pass field", async () => {
    const h = new RegisterHarness({ keyKind: "account", maskedEmail: "j***@x.com" });
    await expect(registerAgent("lv_account_secret", h.store, baseOpts(h))).rejects.toBeInstanceOf(
      OTPPendingError,
    );
    expect(h.lastOTP?.pass).toBe("lv_account_secret");
    expect(h.lastOTP?.aspId).toBe("agent");
  });
});

describe("registerAgent — validation + OTPPendingError message", () => {
  it("rejects empty key, null store, and both OTP options", async () => {
    const store = new MemoryAgentStateStore();
    await expect(registerAgent("", store)).rejects.toBeInstanceOf(RegisterConfigError);
    await expect(
      registerAgent("lv_key", null as unknown as MemoryAgentStateStore),
    ).rejects.toBeInstanceOf(RegisterConfigError);
    await expect(
      registerAgent("lv_key", store, { otp: "1", otpProvider: () => "2" }),
    ).rejects.toBeInstanceOf(RegisterConfigError);
    await expect(registerAgent("lv_key", store, { baseUrl: "ftp://x" })).rejects.toBeInstanceOf(
      RegisterConfigError,
    );
    await expect(registerAgent("lv_key", store, { deviceId: "  " })).rejects.toBeInstanceOf(
      RegisterConfigError,
    );
  });

  it("a corrupt loaded keypair surfaces the register front-door class", async () => {
    // Mirrors Go TestLoadPath_CorruptKeypairMatchesFrontDoorClass for the register
    // side: bad base64, non-x25519, pub-mismatch, and an EMPTY private key all map
    // to RegisterConfigError (the empty key exercises the strict-decode reject).
    for (const bad of [
      { private_key_b64: "not-base64", public_key_b64: "also-bad" },
      { private_key_b64: btoa("too short"), public_key_b64: "" },
      { private_key_b64: btoa("\0".repeat(32)), public_key_b64: btoa("\x01".repeat(32)) },
      { private_key_b64: "", public_key_b64: "" }, // empty key: malformed, must not decode to []
    ]) {
      const store = new MemoryAgentStateStore({ ...bad });
      await expect(
        registerAgent("lv_key", store, { now: () => 1_700_000_000_000 }),
      ).rejects.toBeInstanceOf(RegisterConfigError);
    }
  });

  it("device-id mismatch on the fast path is a config error", async () => {
    const priv = seededRandomBytes(5)(32);
    const { x25519 } = await import("@noble/curves/ed25519.js");
    const state: AgentState = {
      private_key_b64: btoa(String.fromCharCode(...priv)),
      public_key_b64: btoa(String.fromCharCode(...x25519.getPublicKey(priv))),
      agent_id: "agent-original",
      registered_at: new Date().toISOString(),
      device_api_key: "lv_device_secret",
      nhp_server_peer: {
        public_key_b64: btoa("\0".repeat(32)),
        host: "h",
        port: 1,
        expire_time: 0,
      },
    };
    const store = new MemoryAgentStateStore(state);
    await expect(
      registerAgent("lv_key", store, { deviceId: "agent-different" }),
    ).rejects.toBeInstanceOf(RegisterConfigError);
  });

  it("OTPPendingError message is actionable and carries the masked email", () => {
    const e = new OTPPendingError({ requestedAt: new Date(), maskedEmail: "j***@x.com" });
    // The guidance must name the actual TS resume path (the `otp` option), NOT the
    // Go `withOTP()` method — an operator/LLM reads this to recover.
    for (const want of ["j***@x.com", "otp", "registerAgent", "expire"]) {
      expect(e.message).toContain(want);
    }
    expect(e.message).not.toContain("withOTP");
    const generic = new OTPPendingError({ requestedAt: new Date() });
    expect(generic.message).toContain("your account email");
  });
});

describe("bootstrapAgent (NHP-native, deprecated) ", () => {
  it("enrolls over NHP via the bootstrap path and returns the AgentState", async () => {
    const h = new RegisterHarness({ keyKind: "bootstrap", expectCredential: "lv_setup_key" });
    const state = await bootstrapAgent("lv_setup_key", h.store, baseOpts(h));
    expect(state.registered_at).toBeTruthy();
    expect(state.agent_id).toMatch(/^agent-/);
    expect(h.regCount).toBe(1);
    expect(h.otpSends).toBe(0);
    // It hit the NHP relay + completion, not the legacy POST /v1/agent/bootstrap.
    expect(h.completionCalls).toBe(1);
  });

  it("input validation surfaces the bootstrap front-door class, not the register class", async () => {
    const store = new MemoryAgentStateStore();
    await expect(bootstrapAgent("", store)).rejects.toBeInstanceOf(BootstrapConfigError);
    await expect(
      bootstrapAgent("lv_setup_key", null as unknown as MemoryAgentStateStore),
    ).rejects.toBeInstanceOf(BootstrapConfigError);
    // A corrupt loaded keypair must also carry the bootstrap class (not register).
    const store2 = new MemoryAgentStateStore({
      private_key_b64: "not-base64",
      public_key_b64: "also-bad",
    });
    await expect(
      bootstrapAgent("lv_setup_key", store2, { now: () => 1_700_000_000_000 }),
    ).rejects.toBeInstanceOf(BootstrapConfigError);
  });

  it("fast path returns a registered legacy state even without a device key", async () => {
    const priv = seededRandomBytes(9)(32);
    const { x25519 } = await import("@noble/curves/ed25519.js");
    const state: AgentState = {
      private_key_b64: btoa(String.fromCharCode(...priv)),
      public_key_b64: btoa(String.fromCharCode(...x25519.getPublicKey(priv))),
      agent_id: "agent-legacy",
      registered_at: new Date().toISOString(),
      nhp_server_peer: {
        public_key_b64: btoa("\0".repeat(32)),
        host: "h",
        port: 1,
        expire_time: 0,
      },
      // No device_api_key: a legacy bootstrap-era state.
    };
    const store = new MemoryAgentStateStore(state);
    const returned = await bootstrapAgent("lv_setup_key", store, { now: () => 1_700_000_000_000 });
    expect(returned.agent_id).toBe("agent-legacy");
  });
});

describe("registerAgent — returned client is usable", () => {
  it("the returned client carries the minted device API key as its bearer", async () => {
    const h = new RegisterHarness({ keyKind: "bootstrap", deviceApiKey: "lv_device_xyz" });
    const { client } = await registerAgent("lv_key", h.store, baseOpts(h));

    expect(client).toBeDefined();
    // The persisted credential is the device key the completion minted, and the
    // client's masked toJSON reflects a non-empty configured key.
    expect(h.store.state?.device_api_key).toBe("lv_device_xyz");
    expect(client.toJSON().apiKey).not.toBe("***"); // a real (masked) key, not the empty placeholder
  });
});
