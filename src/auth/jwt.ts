import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { getBotCredentials, getEnv } from "../config";

export type AuthUser = {
  oid: string;
  tid: string;
  name?: string;
  preferredUsername?: string;
};

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(tenantKey: string) {
  const tid = tenantKey || "common";
  let set = jwksByIssuer.get(tid);
  if (!set) {
    set = createRemoteJWKSet(
      new URL(
        `https://login.microsoftonline.com/${tid}/discovery/v2.0/keys`
      )
    );
    jwksByIssuer.set(tid, set);
  }
  return set;
}

function allowedAudiences(appId: string): string[] {
  const audiences = new Set<string>([
    appId,
    `api://botid-${appId}`,
    `api://${appId}`,
  ]);

  // Tab SSO resource URIs include the iframe host (must match webApplicationInfo.resource).
  for (const origin of getEnv("TAB_ORIGIN")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    try {
      const host = new URL(origin).host;
      audiences.add(`api://${host}/${appId}`);
      audiences.add(`api://${host}/botid-${appId}`);
    } catch {
      // ignore invalid origins
    }
  }

  const explicit = getEnv("TEAMS_APP_RESOURCE").trim();
  if (explicit) {
    audiences.add(explicit);
  }

  return Array.from(audiences);
}

function parseAllowedTenants(): string[] | null {
  const raw = getEnv("ALLOWED_TENANT_IDS").trim();
  if (!raw) {
    return null;
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function verifyTeamsBearerToken(
  authorizationHeader: string | null | undefined
): Promise<AuthUser> {
  if (!authorizationHeader?.startsWith("Bearer ")) {
    throw new AuthError(401, "Missing Bearer token");
  }
  const token = authorizationHeader.slice("Bearer ".length).trim();
  if (!token) {
    throw new AuthError(401, "Missing Bearer token");
  }

  const { appId, tenantId: homeTenant } = getBotCredentials();
  const audiences = allowedAudiences(appId);

  let payload: JWTPayload | null = null;
  const tryKeys = Array.from(
    new Set([homeTenant || "common", "common", "organizations"])
  );

  for (const key of tryKeys) {
    try {
      const result = await jwtVerify(token, getJwks(key), {
        audience: audiences,
        clockTolerance: 60,
      });
      payload = result.payload;
      break;
    } catch {
      // try next JWKS source
    }
  }

  if (!payload) {
    throw new AuthError(401, "Invalid token");
  }

  const tid = String(payload.tid ?? "");
  const oid = String(payload.oid ?? payload.sub ?? "");
  if (!oid || !tid) {
    throw new AuthError(401, "Token missing oid/tid");
  }

  const allowed = parseAllowedTenants();
  if (allowed && !allowed.includes(tid)) {
    throw new AuthError(403, "Tenant not allowed");
  }

  return {
    oid,
    tid,
    name: payload.name ? String(payload.name) : undefined,
    preferredUsername: payload.preferred_username
      ? String(payload.preferred_username)
      : undefined,
  };
}

export class AuthError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
    this.name = "AuthError";
  }
}
