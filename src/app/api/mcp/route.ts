import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { mcpUrl, originOf, verifyAccessToken } from "@/lib/connector/oauth";
import { createDossierServer } from "@/lib/connector/tools";
import { logServerError } from "@/lib/log";

// The Claude connector: Dossier as a remote MCP server (Streamable HTTP),
// for Claude's custom connectors at this address, /api/mcp. Each request is
// answered on its own (no MCP session), so it works on any instance, and
// it needs an access token from Dossier's own sign-in (src/lib/connector).

export const maxDuration = 120;

/** "Sign in first", with where Claude finds out how (RFC 9728). */
function unauthorized(request: Request): Response {
  const origin = originOf(request);
  return new Response(JSON.stringify({ error: "invalid_token", error_description: "Connect Claude to Dossier first." }), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp", scope="dossier"`,
    },
  });
}

async function handle(request: Request): Promise<Response> {
  const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!(await verifyAccessToken(token))) return unauthorized(request);

  const origin = originOf(request);
  const server = createDossierServer(origin);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    return await transport.handleRequest(request);
  } catch (error) {
    logServerError(`MCP ${mcpUrl(origin)}`, error);
    return Response.json({ jsonrpc: "2.0", error: { code: -32603, message: "Dossier couldn't answer that." }, id: null }, { status: 500 });
  }
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
