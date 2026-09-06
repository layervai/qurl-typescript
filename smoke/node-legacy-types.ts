import {
  createPortalOpener,
  PortalBusyError,
  PortalInvalidReplyError,
  type CreatePortalOpenerOptions,
  type PortalOpener,
} from "@layervai/qurl/node";
import { QURLClient } from "@layervai/qurl";

const options: CreatePortalOpenerOptions = {
  qurl: "https://qurl.link/#qv2t1.example",
  transport: "native-only",
};
const opener: PortalOpener = createPortalOpener(options);
const busy: Error = new PortalBusyError();
const invalidReply: Error = new PortalInvalidReplyError("invalid reply");
const client: QURLClient = new QURLClient({ apiKey: "test" });
void opener;
void busy;
void invalidReply;
void client;
