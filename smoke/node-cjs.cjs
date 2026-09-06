const nodeSdk = require("@layervai/qurl/node");

if (typeof nodeSdk.createPortalOpener !== "function") {
  throw new Error("CJS Node entry does not export createPortalOpener");
}
if (typeof nodeSdk.PortalBusyError !== "function") {
  throw new Error("CJS Node entry does not export PortalBusyError");
}
if (typeof nodeSdk.PortalInvalidReplyError !== "function") {
  throw new Error("CJS Node entry does not export PortalInvalidReplyError");
}

console.log("node cjs smoke ok");
