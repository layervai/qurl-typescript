globalThis.fetch = undefined;

if (typeof AbortSignal.any !== "function") {
  throw new Error("Node entry requires AbortSignal.any");
}
const source = new AbortController();
const composite = AbortSignal.any([source.signal]);
const reason = new Error("composite abort smoke");
source.abort(reason);
if (!composite.aborted || composite.reason !== reason) {
  throw new Error("AbortSignal.any did not preserve the source abort reason");
}

const { createPortalOpener } = await import("@layervai/qurl/node");
const opener = createPortalOpener({
  qurl: "https://qurl.link/#qv2t1.smoke",
  fetch: async () => {
    throw new Error("custom protected-content Fetch must not run during construction");
  },
});

await opener.close();
console.log("node no-global-fetch smoke ok");
