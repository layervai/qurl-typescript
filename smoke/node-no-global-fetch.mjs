globalThis.fetch = undefined;

const { createPortalOpener } = await import("@layervai/qurl/node");
const opener = createPortalOpener({
  qurl: "https://qurl.link/#qv2t1.smoke",
  fetch: async () => {
    throw new Error("custom protected-content Fetch must not run during construction");
  },
});

await opener.close();
console.log("node no-global-fetch smoke ok");
