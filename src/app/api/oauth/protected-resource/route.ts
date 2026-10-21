import { NextResponse } from "next/server";

import { originOf, protectedResourceMetadata } from "@/lib/connector/oauth";

/** /.well-known/oauth-protected-resource (a rewrite in next.config.ts): who guards /api/mcp. */
export function GET(request: Request) {
  return NextResponse.json(protectedResourceMetadata(originOf(request)), { headers: { "access-control-allow-origin": "*" } });
}
