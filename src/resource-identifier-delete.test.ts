import { expect, it } from "vitest";
import { createClient, mockFetch } from "./__tests__/test-helpers.js";
import { ValidationError } from "./errors.js";

it("keeps migration deletion routes and rejects token/path identifiers before HTTP", async () => {
  const fetch = mockFetch({ status: 204 });
  const client = createClient(fetch);
  const crid = "ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a";
  const key =
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2cTVv5_3eeYCcLLq5ROYCqcmY50HiKZ9ATglIkPnCji1E_S63UMtXba1moR8-Q6EV7oM6zwwh9_j2CDujzXvLA";
  for (const [id, route] of [
    ["r_abcdefghijk", "qurls"],
    [key, "resources"],
    [crid, "resources"],
  ]) {
    await client.deleteResourceByIdentifier(id!);
    const [url, request] = fetch.mock.calls.at(-1)!;
    expect(String(url)).toContain(`/v1/${route}/${id}`);
    expect(request?.method).toBe("DELETE");
  }
  expect(fetch).toHaveBeenCalledTimes(3);
  for (const id of [
    "q_0123456789a",
    "at_secret",
    "../resource",
    "r_abcdefghijk/path",
    "",
    "A".repeat(109),
  ]) {
    await expect(client.deleteResourceByIdentifier(id)).rejects.toBeInstanceOf(ValidationError);
  }
  expect(fetch).toHaveBeenCalledTimes(3);
});
