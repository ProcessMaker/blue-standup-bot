import { getEnv } from "../config";
import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { AuthError, verifyTeamsBearerToken, type AuthUser } from "../auth/jwt";

export function corsHeaders(request: HttpRequest): Record<string, string> {
  const requestOrigin = request.headers.get("origin") ?? "";
  const configured = getEnv("TAB_ORIGIN")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const defaults = [
    "https://processmaker.github.io",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ];
  const allowed = configured.length > 0 ? configured : defaults;
  const origin =
    requestOrigin && allowed.some((a) => requestOrigin === a || requestOrigin.startsWith(a))
      ? requestOrigin
      : allowed[0];

  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, X-Requested-With",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function jsonResponse(
  request: HttpRequest,
  status: number,
  body: unknown
): HttpResponseInit {
  return {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json",
    },
    jsonBody: body,
  };
}

export function optionsResponse(request: HttpRequest): HttpResponseInit {
  return {
    status: 204,
    headers: corsHeaders(request),
  };
}

export async function requireAuth(
  request: HttpRequest
): Promise<AuthUser | HttpResponseInit> {
  try {
    return await verifyTeamsBearerToken(
      request.headers.get("authorization")
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return jsonResponse(request, err.status, { error: err.message });
    }
    console.error("[requireAuth]", err);
    return jsonResponse(request, 401, { error: "Unauthorized" });
  }
}

export function isHttpResponse(
  value: AuthUser | HttpResponseInit
): value is HttpResponseInit {
  return typeof value === "object" && value !== null && "status" in value;
}
