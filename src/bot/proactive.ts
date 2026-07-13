import {
  MessageFactory,
  TurnContext,
  type ChannelAccount,
  type ConversationParameters,
  type ConversationReference,
} from "botbuilder";
import { getBotCredentials } from "../config";
import { getConversationRef, upsertConversationRef } from "../db/client";
import { getAdapter, isPersonalConversationReference } from "./teams";

/**
 * Send a 1:1 Teams DM. Prefers a stored *personal* conversation reference;
 * otherwise creates a personal chat. Channel/group refs are ignored so
 * reminders and installer welcomes never post into a team channel.
 */
export async function sendProactiveDm(params: {
  tenantId: string;
  userAadId: string;
  message: string;
  /** Prefer the serviceUrl from the triggering activity when available. */
  serviceUrl?: string;
}): Promise<void> {
  const adapter = getAdapter();
  const { appId } = getBotCredentials();
  const { tenantId, userAadId, message } = params;

  const raw = await getConversationRef(userAadId, tenantId);
  if (raw) {
    const reference = JSON.parse(raw) as ConversationReference;
    if (isPersonalConversationReference(reference)) {
      await adapter.continueConversationAsync(
        appId,
        reference,
        async (turnContext) => {
          await turnContext.sendActivity(MessageFactory.text(message));
        }
      );
      return;
    }
    console.info(
      `[sendProactiveDm] ignoring non-personal stored ref for user=${userAadId}; creating 1:1`
    );
  }

  const serviceUrl =
    params.serviceUrl ||
    process.env.BotServiceUrl ||
    "https://smba.trafficmanager.net/teams/";

  const conversationParameters: ConversationParameters = {
    isGroup: false,
    bot: { id: appId, name: "Blue Standup Bot" },
    members: [{ id: userAadId, aadObjectId: userAadId } as ChannelAccount],
    tenantId,
    channelData: { tenant: { id: tenantId } },
  };

  await adapter.createConversationAsync(
    appId,
    "msteams",
    serviceUrl,
    "https://api.botframework.com",
    conversationParameters,
    async (turnContext) => {
      await turnContext.sendActivity(MessageFactory.text(message));
      const ref = TurnContext.getConversationReference(turnContext.activity);
      await upsertConversationRef({
        userAadId,
        tenantId,
        conversationRef: JSON.stringify(ref),
      });
    }
  );
}
