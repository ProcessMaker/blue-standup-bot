export type StandupUser = {
  userAadId: string;
  displayName: string | null;
};

export type Standup = {
  id: string;
  tenantId: string;
  teamId: string;
  teamName: string | null;
  name: string;
  notifyTimeUtc: string;
  message: string;
  enabled: boolean;
  createdByAadId: string | null;
  updatedByAadId: string | null;
  userCount?: number;
  users?: StandupUser[];
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(
  /\/$/,
  ""
);

export function apiConfigured(): boolean {
  return Boolean(API_BASE);
}

async function request<T>(
  path: string,
  token: string,
  init?: RequestInit
): Promise<T> {
  if (!API_BASE) {
    throw new Error("VITE_API_BASE_URL is not configured");
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
  } & T;
  if (!response.ok) {
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  return body;
}

export function listStandups(teamId: string, token: string) {
  return request<{ standups: Standup[] }>(
    `/api/teams/${encodeURIComponent(teamId)}/standups`,
    token
  );
}

export function getStandup(teamId: string, standupId: string, token: string) {
  return request<{ standup: Standup }>(
    `/api/teams/${encodeURIComponent(teamId)}/standups/${encodeURIComponent(standupId)}`,
    token
  );
}

export function createStandup(
  teamId: string,
  token: string,
  payload: Partial<Standup> & { name: string }
) {
  return request<{ standup: Standup }>(
    `/api/teams/${encodeURIComponent(teamId)}/standups`,
    token,
    { method: "POST", body: JSON.stringify(payload) }
  );
}

export function updateStandup(
  teamId: string,
  standupId: string,
  token: string,
  payload: Partial<Standup>
) {
  return request<{ standup: Standup }>(
    `/api/teams/${encodeURIComponent(teamId)}/standups/${encodeURIComponent(standupId)}`,
    token,
    { method: "PATCH", body: JSON.stringify(payload) }
  );
}

export function deleteStandup(
  teamId: string,
  standupId: string,
  token: string
) {
  return request<{ deleted: boolean }>(
    `/api/teams/${encodeURIComponent(teamId)}/standups/${encodeURIComponent(standupId)}`,
    token,
    { method: "DELETE" }
  );
}

export function putStandupUsers(
  teamId: string,
  standupId: string,
  token: string,
  users: StandupUser[]
) {
  return request<{ standup: Standup }>(
    `/api/teams/${encodeURIComponent(teamId)}/standups/${encodeURIComponent(standupId)}/users`,
    token,
    { method: "PUT", body: JSON.stringify({ users }) }
  );
}
