import * as microsoftTeams from "@microsoft/teams-js";

export async function ensureTeamsApp(): Promise<void> {
  await microsoftTeams.app.initialize();
}

export async function getTeamsContext(): Promise<microsoftTeams.app.Context> {
  await ensureTeamsApp();
  return microsoftTeams.app.getContext();
}

export async function getAuthToken(): Promise<string> {
  await ensureTeamsApp();
  const resource = import.meta.env.VITE_TEAMS_APP_RESOURCE as string | undefined;
  if (resource) {
    return microsoftTeams.authentication.getAuthToken({
      resources: [resource],
    });
  }
  return microsoftTeams.authentication.getAuthToken();
}

/** Teams native people picker for tabs (returns AAD object ids + display names). */
export async function openPeoplePicker(options?: {
  setSelected?: string[];
}): Promise<{ userAadId: string; displayName: string | null }[]> {
  await ensureTeamsApp();
  if (!microsoftTeams.people?.isSupported?.() || !microsoftTeams.people.selectPeople) {
    throw new Error("People picker is not available in this client");
  }

  try {
    const picked = await microsoftTeams.people.selectPeople({
      title: "Add standup users",
      openOrgWideSearchInChatOrChannel: true,
      singleSelect: false,
      setSelected: options?.setSelected,
    });
    return (picked ?? [])
      .filter((p) => Boolean(p.objectId))
      .map((p) => ({
        userAadId: p.objectId,
        displayName: p.displayName ?? null,
      }));
  } catch (err) {
    const sdkErr = err as { errorCode?: number; message?: string };
    // 8000 = USER_ABORT (user cancelled the picker)
    if (sdkErr?.errorCode === 8000) {
      return [];
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function registerTabConfig(params: {
  teamId: string;
  teamName?: string | null;
}): Promise<void> {
  await ensureTeamsApp();
  const origin = window.location.origin;
  const basen = "/blue-standup-bot";
  const contentUrl = `${origin}${basen}/#/?teamId=${encodeURIComponent(params.teamId)}`;
  const websiteUrl = contentUrl;
  const entityId = `standup:${params.teamId}`;
  const suggestedTabName = "Standups";

  microsoftTeams.pages.config.registerOnSaveHandler((saveEvent) => {
    microsoftTeams.pages.config
      .setConfig({
        suggestedDisplayName: suggestedTabName,
        entityId,
        contentUrl,
        websiteUrl,
      })
      .then(() => saveEvent.notifySuccess())
      .catch((err) => saveEvent.notifyFailure(String(err)));
  });

  microsoftTeams.pages.config.setValidityState(true);
}
