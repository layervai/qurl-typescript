import {
  createPortalOpener,
  PortalBusyError,
  PortalInvalidReplyError,
  PortalOpenerClosedError,
  PortalOpenerNotReadyError,
  PortalOpenerNotStartedError,
  PortalOpenTimeoutError,
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
for (const [name, value] of Object.entries({
  PortalOpenerClosedError,
  PortalOpenerNotReadyError,
  PortalOpenerNotStartedError,
  PortalOpenTimeoutError,
  PortalRedirectError,
  PortalTargetChangedError,
  PortalTooManyRedirectsError,
})) {
  if (typeof value === "function") continue;
  throw new Error(`ESM Node entry does not export ${name}`);
}

console.log("node esm smoke ok");
