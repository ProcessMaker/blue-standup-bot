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

export function peoplePickerCard(): Record<string, unknown> {
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "Add standup users",
        weight: "Bolder",
        size: "Medium",
      },
      {
        type: "TextBlock",
        text: "Search and select people to remind about standup.",
        wrap: true,
      },
      {
        type: "Input.ChoiceSet",
        id: "users",
        isMultiSelect: true,
        style: "filtered",
        placeholder: "Search for people",
        choices: [],
        "choices.data": {
          type: "Data.Query",
          dataset: "graph.microsoft.com/users?scope=currentContext",
        },
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Add",
        data: { action: "addUsers" },
      },
    ],
  };
}

/** Parse Adaptive Card people picker submit values into AAD ids. */
export function parseSelectedUserIds(raw: unknown): string[] {
  if (raw == null) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.map(String).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.userIds)) {
      return obj.userIds.map(String);
    }
    if (typeof obj.userIds === "string") {
      return parseSelectedUserIds(obj.userIds);
    }
  }
  return [];
}

export async function openPeoplePicker(): Promise<
  { userAadId: string; displayName: string | null }[]
> {
  await ensureTeamsApp();
  if (!microsoftTeams.dialog?.adaptiveCard?.open) {
    throw new Error("Adaptive Card dialog is not available in this client");
  }

  return new Promise((resolve, reject) => {
    microsoftTeams.dialog.adaptiveCard.open(
      {
        card: JSON.stringify(peoplePickerCard()),
        title: "Add people",
        size: { height: 400, width: 500 },
      },
      (result) => {
        if (result.err) {
          // User cancelled
          if (String(result.err).toLowerCase().includes("cancel")) {
            resolve([]);
            return;
          }
          reject(new Error(String(result.err)));
          return;
        }
        const data = (result.result ?? {}) as Record<string, unknown>;
        const ids = parseSelectedUserIds(data.users);
        resolve(
          ids.map((id) => ({
            userAadId: id,
            displayName: null,
          }))
        );
      }
    );
  });
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
