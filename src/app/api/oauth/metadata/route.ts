import { NextResponse } from "next/server";

import { authorizationServerMetadata, originOf } from "@/lib/connector/oauth";

/** /.well-known/oauth-authorization-server (a rewrite in next.config.ts): how Claude signs in. */
export function GET(request: Request) {
  return NextResponse.json(authorizationServerMetadata(originOf(request)), { headers: { "access-control-allow-origin": "*" } });
}
