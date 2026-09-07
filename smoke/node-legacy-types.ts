import {
  createPortalOpener,
  PortalBusyError,
  PortalInvalidReplyError,
  PortalOpenerNotReadyError,
  PortalTargetChangedError,
  type CreatePortalOpenerOptions,
  type PortalOpener,
  type PortalOpenerHealth,
  type PortalOpenerState,
} from "@layervai/qurl/node";
import { QURLClient } from "@layervai/qurl";

const options: CreatePortalOpenerOptions = {
  qurl: "https://qurl.link/#qv2t1.example",
  fetch,
};
const opener: PortalOpener = createPortalOpener(options);
const busy: Error = new PortalBusyError();
const invalidReply: Error = new PortalInvalidReplyError("invalid reply");
const notReady: Error = new PortalOpenerNotReadyError();
const targetChanged: Error = new PortalTargetChangedError();
const health: PortalOpenerHealth = opener.health();
const state: PortalOpenerState = opener.health().state;
const client: QURLClient = new QURLClient({ apiKey: "test" });
void opener;
void busy;
void invalidReply;
void notReady;
void targetChanged;
void health;
void state;
void client;
