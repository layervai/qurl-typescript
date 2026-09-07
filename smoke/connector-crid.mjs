// Native HTTP consumer journey through both published package entry points.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const resource = {
  resource_id:
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2cTVv5_3eeYCcLLq5ROYCqcmY50HiKZ9ATglIkPnCji1E_S63UMtXba1moR8-Q6EV7oM6zwwh9_j2CDujzXvLA",
  crid: "ahpviqz46qwcvx56glfatm3p3ooccwfcf2it4sdgjervwdkapykw3o3qdq2a",
  connector_routing_id: "c-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  knock_resource_id: "smoke-admission",
  slug: "smoke-connector",
  type: "tunnel",
  status: "active",
};
const calls = [];
const path = `/v1/resources/${resource.crid}`;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  calls.push([req.method, req.url, Buffer.concat(chunks).toString()]);
  res.setHeader("content-type", "application/json");
  if (req.method === "POST" && req.url === "/v1/resources") {
    res.writeHead(201).end(JSON.stringify({ data: resource, meta: { found_existing: false } }));
  } else if (req.method === "GET" && req.url === path) {
    res.end(JSON.stringify({ data: { resource } }));
  } else if (req.method === "POST" && req.url === `${path}/qurls`) {
    res.writeHead(201).end(
      JSON.stringify({
        data: { resource_id: resource.resource_id, qurl_link: "https://qurl.link/#at_smoke" },
      }),
    );
  } else if (req.method === "DELETE" && req.url === path) {
    res.writeHead(204).end();
  } else res.writeHead(404).end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  for (const [name, sdk] of [
    ["ESM", await import("@layervai/qurl")],
    ["CJS", require("@layervai/qurl")],
  ]) {
    calls.length = 0;
    const client = new sdk.QURLClient({
      apiKey: "local-smoke-only",
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    });
    const result = await client.ensureConnectorResource(resource.slug);
    assert.equal(result.resource.crid, resource.crid);
    const loaded = await client.getConnectorResource(result.resource.crid);
    await loaded.createPortal();
    await client.deleteConnectorResource(loaded.crid);
    assert.deepEqual(calls, [
      [
        "POST",
        "/v1/resources",
        JSON.stringify({ type: "tunnel", slug: resource.slug, find_or_create: true }),
      ],
      ["GET", path, ""],
      ["POST", `${path}/qurls`, "{}"],
      ["DELETE", path, ""],
    ]);
    await assert.rejects(client.getConnectorResource(resource.resource_id), {
      code: sdk.ERROR_CODE_CLIENT_VALIDATION,
    });
    await assert.rejects(client.deleteConnectorResource(resource.resource_id), {
      code: sdk.ERROR_CODE_CLIENT_VALIDATION,
    });
    assert.equal(calls.length, 4, "public-key compatibility fallback reached HTTP");
    console.log(`${name}: Connector CRID ensure/get/mint/delete HTTP smoke passed`);
  }
} finally {
  server.closeAllConnections();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
