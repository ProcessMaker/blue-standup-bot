import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import {
  createConfig,
  deleteConfig,
  getConfigByTeamAndId,
  listConfigsByTeam,
  listUsers,
  replaceUsers,
  updateConfig,
} from "../db/client";
import { formatTimeUtc, parseTimeUtc } from "../config";
import {
  isHttpResponse,
  jsonResponse,
  optionsResponse,
  requireAuth,
} from "../api/http";

function serializeConfig(
  config: Awaited<ReturnType<typeof getConfigByTeamAndId>>,
  users?: Awaited<ReturnType<typeof listUsers>>
) {
  if (!config) {
    return null;
  }
  return {
    id: config.id,
    tenantId: config.tenantId,
    teamId: config.teamId,
    teamName: config.teamName,
    name: config.name,
    notifyTimeUtc: formatTimeUtc(config.notifyTimeUtc),
    message: config.message,
    enabled: config.enabled,
    createdByAadId: config.createdByAadId,
    updatedByAadId: config.updatedByAadId,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
    userCount: config.userCount,
    users: users?.map((u) => ({
      userAadId: u.userAadId,
      displayName: u.displayName,
    })),
  };
}

async function listStandups(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  if (request.method === "OPTIONS") {
    return optionsResponse(request);
  }
  const auth = await requireAuth(request);
  if (isHttpResponse(auth)) {
    return auth;
  }

  const teamId = request.params.teamId;
  if (!teamId) {
    return jsonResponse(request, 400, { error: "Missing teamId" });
  }

  try {
    const configs = await listConfigsByTeam(teamId);
    return jsonResponse(request, 200, {
      standups: configs.map((c) => serializeConfig(c)),
    });
  } catch (err) {
    context.error("[listStandups]", err);
    return jsonResponse(request, 500, { error: "Failed to list standups" });
  }
}

async function createStandup(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  if (request.method === "OPTIONS") {
    return optionsResponse(request);
  }
  const auth = await requireAuth(request);
  if (isHttpResponse(auth)) {
    return auth;
  }

  const teamId = request.params.teamId;
  if (!teamId) {
    return jsonResponse(request, 400, { error: "Missing teamId" });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(request, 400, { error: "Invalid JSON body" });
  }

  const name = String(body.name ?? "").trim();
  if (!name || name.length > 128) {
    return jsonResponse(request, 400, {
      error: "name is required (max 128 chars)",
    });
  }

  let notifyTimeUtc = "15:00:00";
  if (body.notifyTimeUtc) {
    const parsed = parseTimeUtc(String(body.notifyTimeUtc));
    if (!parsed) {
      return jsonResponse(request, 400, {
        error: "notifyTimeUtc must be HH:MM (UTC)",
      });
    }
    notifyTimeUtc = parsed;
  }

  const message =
    body.message != null ? String(body.message) : undefined;
  if (message && message.length > 2000) {
    return jsonResponse(request, 400, {
      error: "message must be 2000 characters or fewer",
    });
  }

  try {
    const config = await createConfig({
      tenantId: auth.tid,
      teamId,
      teamName: body.teamName != null ? String(body.teamName) : null,
      name,
      createdByAadId: auth.oid,
      notifyTimeUtc,
      message,
      enabled: Boolean(body.enabled),
    });
    return jsonResponse(request, 201, { standup: serializeConfig(config) });
  } catch (err) {
    context.error("[createStandup]", err);
    return jsonResponse(request, 500, { error: "Failed to create standup" });
  }
}

async function getStandup(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  if (request.method === "OPTIONS") {
    return optionsResponse(request);
  }
  const auth = await requireAuth(request);
  if (isHttpResponse(auth)) {
    return auth;
  }

  const teamId = request.params.teamId;
  const standupId = request.params.standupId;
  if (!teamId || !standupId) {
    return jsonResponse(request, 400, { error: "Missing ids" });
  }

  try {
    const config = await getConfigByTeamAndId(teamId, standupId);
    if (!config) {
      return jsonResponse(request, 404, { error: "Standup not found" });
    }
    const users = await listUsers(config.id);
    return jsonResponse(request, 200, {
      standup: serializeConfig(config, users),
    });
  } catch (err) {
    context.error("[getStandup]", err);
    return jsonResponse(request, 500, { error: "Failed to load standup" });
  }
}

async function patchStandup(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  if (request.method === "OPTIONS") {
    return optionsResponse(request);
  }
  const auth = await requireAuth(request);
  if (isHttpResponse(auth)) {
    return auth;
  }

  const teamId = request.params.teamId;
  const standupId = request.params.standupId;
  if (!teamId || !standupId) {
    return jsonResponse(request, 400, { error: "Missing ids" });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(request, 400, { error: "Invalid JSON body" });
  }

  let notifyTimeUtc: string | undefined;
  if (body.notifyTimeUtc != null) {
    const parsed = parseTimeUtc(String(body.notifyTimeUtc));
    if (!parsed) {
      return jsonResponse(request, 400, {
        error: "notifyTimeUtc must be HH:MM (UTC)",
      });
    }
    notifyTimeUtc = parsed;
  }

  if (body.name != null) {
    const name = String(body.name).trim();
    if (!name || name.length > 128) {
      return jsonResponse(request, 400, {
        error: "name is required (max 128 chars)",
      });
    }
  }

  if (body.message != null && String(body.message).length > 2000) {
    return jsonResponse(request, 400, {
      error: "message must be 2000 characters or fewer",
    });
  }

  try {
    const updated = await updateConfig({
      teamId,
      configId: standupId,
      updatedByAadId: auth.oid,
      name: body.name != null ? String(body.name).trim() : undefined,
      teamName:
        body.teamName !== undefined
          ? body.teamName == null
            ? null
            : String(body.teamName)
          : undefined,
      notifyTimeUtc,
      message: body.message != null ? String(body.message) : undefined,
      enabled:
        body.enabled !== undefined ? Boolean(body.enabled) : undefined,
    });
    if (!updated) {
      return jsonResponse(request, 404, { error: "Standup not found" });
    }
    const users = await listUsers(updated.id);
    return jsonResponse(request, 200, {
      standup: serializeConfig(updated, users),
    });
  } catch (err) {
    context.error("[patchStandup]", err);
    return jsonResponse(request, 500, { error: "Failed to update standup" });
  }
}

async function removeStandup(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  if (request.method === "OPTIONS") {
    return optionsResponse(request);
  }
  const auth = await requireAuth(request);
  if (isHttpResponse(auth)) {
    return auth;
  }

  const teamId = request.params.teamId;
  const standupId = request.params.standupId;
  if (!teamId || !standupId) {
    return jsonResponse(request, 400, { error: "Missing ids" });
  }

  try {
    const ok = await deleteConfig(teamId, standupId);
    if (!ok) {
      return jsonResponse(request, 404, { error: "Standup not found" });
    }
    return jsonResponse(request, 200, { deleted: true });
  } catch (err) {
    context.error("[removeStandup]", err);
    return jsonResponse(request, 500, { error: "Failed to delete standup" });
  }
}

async function putUsers(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  if (request.method === "OPTIONS") {
    return optionsResponse(request);
  }
  const auth = await requireAuth(request);
  if (isHttpResponse(auth)) {
    return auth;
  }

  const teamId = request.params.teamId;
  const standupId = request.params.standupId;
  if (!teamId || !standupId) {
    return jsonResponse(request, 400, { error: "Missing ids" });
  }

  const config = await getConfigByTeamAndId(teamId, standupId);
  if (!config) {
    return jsonResponse(request, 404, { error: "Standup not found" });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(request, 400, { error: "Invalid JSON body" });
  }

  const rawUsers = Array.isArray(body.users) ? body.users : null;
  if (!rawUsers) {
    return jsonResponse(request, 400, { error: "users array required" });
  }

  const users: { userAadId: string; displayName?: string | null }[] = [];
  for (const item of rawUsers) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    const userAadId = String(row.userAadId ?? "").trim();
    if (!userAadId) {
      continue;
    }
    users.push({
      userAadId,
      displayName:
        row.displayName == null ? null : String(row.displayName),
    });
  }

  try {
    const saved = await replaceUsers(config.id, users);
    await updateConfig({
      teamId,
      configId: standupId,
      updatedByAadId: auth.oid,
    });
    const refreshed = await getConfigByTeamAndId(teamId, standupId);
    return jsonResponse(request, 200, {
      standup: serializeConfig(refreshed, saved),
    });
  } catch (err) {
    context.error("[putUsers]", err);
    return jsonResponse(request, 500, { error: "Failed to update users" });
  }
}

app.http("standupsListCreate", {
  methods: ["GET", "POST", "OPTIONS"],
  authLevel: "anonymous",
  route: "teams/{teamId}/standups",
  handler: async (request, context) => {
    if (request.method === "GET" || request.method === "OPTIONS") {
      return listStandups(request, context);
    }
    return createStandup(request, context);
  },
});

app.http("standupById", {
  methods: ["GET", "PATCH", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  route: "teams/{teamId}/standups/{standupId}",
  handler: async (request, context) => {
    if (request.method === "OPTIONS") {
      return optionsResponse(request);
    }
    if (request.method === "GET") {
      return getStandup(request, context);
    }
    if (request.method === "PATCH") {
      return patchStandup(request, context);
    }
    return removeStandup(request, context);
  },
});

app.http("standupUsers", {
  methods: ["PUT", "OPTIONS"],
  authLevel: "anonymous",
  route: "teams/{teamId}/standups/{standupId}/users",
  handler: putUsers,
});
