import { createPortalOpener } from "@layervai/qurl/node";

if (typeof createPortalOpener !== "function") {
  throw new Error("ESM Node entry does not export createPortalOpener");
}

console.log("node esm smoke ok");
