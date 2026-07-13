import {
  CloudAdapter,
  ConfigurationBotFrameworkAuthentication,
  ConfigurationServiceClientCredentialFactory,
  TurnContext,
  type ConversationReference,
} from "botbuilder";
import { getBotCredentials } from "../config";

let adapterSingleton: CloudAdapter | null = null;

export function getAdapter(): CloudAdapter {
  if (adapterSingleton) {
    return adapterSingleton;
  }

  const { appId, appPassword, tenantId } = getBotCredentials();
  // Azure Bot Service no longer allows creating MultiTenant bots. Keep the
  // Bot Framework adapter SingleTenant (publisher home tenant).
  const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
    MicrosoftAppId: appId,
    MicrosoftAppPassword: appPassword,
    MicrosoftAppType: "SingleTenant",
    MicrosoftAppTenantId: tenantId || undefined,
  });

  const botFrameworkAuthentication = new ConfigurationBotFrameworkAuthentication(
    {},
    credentialsFactory
  );

  adapterSingleton = new CloudAdapter(botFrameworkAuthentication);
  adapterSingleton.onTurnError = async (context, error) => {
    console.error("[onTurnError]", error);
    try {
      await context.sendActivity(
        "Sorry, something went wrong processing that request."
      );
    } catch {
      // ignore secondary failures
    }
  };

  return adapterSingleton;
}

export function getTenantId(context: TurnContext): string {
  return (
    context.activity.conversation?.tenantId ||
    (context.activity.channelData as { tenant?: { id?: string } })?.tenant
      ?.id ||
    ""
  );
}

export function getTeamFromActivity(context: TurnContext): {
  id: string;
  name?: string;
  aadGroupId?: string;
} | null {
  const team = (
    context.activity.channelData as {
      team?: { id?: string; name?: string; aadGroupId?: string };
    }
  )?.team;
  if (team?.id) {
    return { id: team.id, name: team.name, aadGroupId: team.aadGroupId };
  }
  return null;
}

export function extractConversationReference(
  context: TurnContext
): Partial<ConversationReference> {
  return TurnContext.getConversationReference(context.activity);
}

/** True for a 1:1 personal chat (not a team channel or group chat). */
export function isPersonalConversation(
  conversation: { conversationType?: string } | null | undefined
): boolean {
  return conversation?.conversationType === "personal";
}

export function isPersonalConversationReference(
  reference: Partial<ConversationReference> | null | undefined
): boolean {
  return isPersonalConversation(reference?.conversation ?? undefined);
}

export function parseSelectedUserIds(value: unknown): string[] {
  if (value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.map(String).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}
