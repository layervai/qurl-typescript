const nodeSdk = require("@layervai/qurl/node");

if (typeof nodeSdk.createPortalOpener !== "function") {
  throw new Error("CJS Node entry does not export createPortalOpener");
}

console.log("node cjs smoke ok");
