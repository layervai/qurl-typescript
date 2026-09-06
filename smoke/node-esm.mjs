import { createPortalOpener, PortalBusyError, PortalInvalidReplyError } from "@layervai/qurl/node";

if (typeof createPortalOpener !== "function") {
  throw new Error("ESM Node entry does not export createPortalOpener");
}
if (typeof PortalBusyError !== "function") {
  throw new Error("ESM Node entry does not export PortalBusyError");
}
if (typeof PortalInvalidReplyError !== "function") {
  throw new Error("ESM Node entry does not export PortalInvalidReplyError");
}

console.log("node esm smoke ok");
