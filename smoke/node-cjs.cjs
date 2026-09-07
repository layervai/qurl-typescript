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
for (const name of [
  "PortalOpenerClosedError",
  "PortalOpenerNotReadyError",
  "PortalOpenerNotStartedError",
  "PortalRedirectError",
  "PortalTargetChangedError",
  "PortalTooManyRedirectsError",
]) {
  if (typeof nodeSdk[name] === "function") continue;
  throw new Error("CJS Node entry does not export portal lifecycle errors");
}

console.log("node cjs smoke ok");
