import {
  createPortalOpener,
  PortalBusyError,
  PortalInvalidReplyError,
  PortalOpenerClosedError,
  PortalOpenerNotReadyError,
  PortalOpenerNotStartedError,
  PortalRedirectError,
  PortalTargetChangedError,
  PortalTooManyRedirectsError,
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
for (const value of [
  PortalOpenerClosedError,
  PortalOpenerNotReadyError,
  PortalOpenerNotStartedError,
  PortalRedirectError,
  PortalTargetChangedError,
  PortalTooManyRedirectsError,
]) {
  if (typeof value === "function") continue;
  throw new Error("ESM Node entry does not export portal lifecycle errors");
}

console.log("node esm smoke ok");
