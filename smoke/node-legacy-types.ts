import {
  createPortalOpener,
  PortalBusyError,
  PortalInvalidReplyError,
  PortalOpenTimeoutError,
  PortalOpenerNotReadyError,
  PortalTargetChangedError,
  type AgentStateCodec,
  type PendingAgentCompletion,
  type AgentTransport,
  type NHPMessage,
  type CreatePortalOpenerOptions,
  type PortalOpener,
  type PortalOpenerHealth,
  type PortalOpenerState,
} from "@layervai/qurl/node";
import { isApiKeyRequestScope, type ApiKeyRequestScope, QURLClient } from "@layervai/qurl";

const options: CreatePortalOpenerOptions = {
  qurl: "https://qurl.link/#qv2t1.example",
  fetch,
};
const opener: PortalOpener = createPortalOpener(options);
const descendant: Promise<Response> = opener.fetchDescendant(["eib_example"], { method: "POST" });
const busy: Error = new PortalBusyError();
const invalidReply: Error = new PortalInvalidReplyError("invalid reply");
const openTimeout: Error = new PortalOpenTimeoutError();
const notReady: Error = new PortalOpenerNotReadyError();
const targetChanged: Error = new PortalTargetChangedError();
const health: PortalOpenerHealth = opener.health();
const state: PortalOpenerState = opener.health().state;
const client: QURLClient = new QURLClient({ apiKey: "test" });
const portal: ReturnType<QURLClient["createPortal"]> = client.createPortal(
  "ae4jqpd7eaoslq7jinmjv4yikgzmcxgpjfsuobiniqnko32lpw743ivbeyha",
  {
    targetPath: "/api/detect/eib_example",
  },
);
void opener;
void descendant;
void busy;
void invalidReply;
void openTimeout;
void notReady;
void targetChanged;
void health;
void state;
void client;
void portal;

// Compile the emitted credential declarations as a package consumer.
const responseScope: string = "qurl:read";
if (isApiKeyRequestScope(responseScope)) {
  const scope: ApiKeyRequestScope = responseScope;
  void client.createApiKey({ name: "durable", scopes: [scope] });
}
void client.createApiKey({ kind: "enrollment_token", name: "agent" });
// @ts-expect-error Durable keys require scopes.
void client.createApiKey({ name: "durable" });
// @ts-expect-error Enrollment scopes are assigned by the service.
void client.createApiKey({ kind: "enrollment_token", name: "agent", scopes: ["qurl:agent"] });
// @ts-expect-error Durable keys cannot expire.
void client.createApiKey({ name: "durable", scopes: ["qurl:read"], expires_in: "1h" });
// @ts-expect-error Retired fields are not accepted.
void client.createApiKey({ name: "durable", scopes: ["qurl:read"], purpose: "tunnel_bootstrap" });

// Public extension types must resolve through the supported Node entry point.
type PublicStateCodec = AgentStateCodec;
type PublicPendingCompletion = PendingAgentCompletion;
type PublicAgentReply = Awaited<ReturnType<AgentTransport>>;
const publicReply: PublicAgentReply = undefined;
const noCodec: PublicStateCodec | undefined = undefined;
const noCompletion: PublicPendingCompletion | undefined = undefined;
const noMessage: NHPMessage | undefined = undefined;
void [publicReply, noCodec, noCompletion, noMessage];
