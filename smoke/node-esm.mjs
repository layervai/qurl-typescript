import {
  createPortalOpener,
  PortalBusyError,
  PortalInvalidReplyError,
  PortalOpenerNotReadyError,
  PortalTargetChangedError,
} from "@layervai/qurl/node";

if (typeof createPortalOpener !== "function") {
  throw new Error("ESM Node entry does not export createPortalOpener");
}
if (typeof PortalBusyError !== "function") {
  throw new Error("ESM Node entry does not export PortalBusyError");
}
if (typeof PortalInvalidReplyError !== "function") {
  throw new Error("ESM Node entry does not export PortalInvalidReplyError");
}
if (
  typeof PortalOpenerNotReadyError !== "function" ||
  typeof PortalTargetChangedError !== "function"
) {
  throw new Error("ESM Node entry does not export portal lifecycle errors");
}

console.log("node esm smoke ok");
