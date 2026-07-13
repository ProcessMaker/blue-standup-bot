import {
  TeamsActivityHandler,
  TurnContext,
  MessageFactory,
} from "botbuilder";
import { upsertConversationRef } from "../db/client";
import { sendProactiveDm } from "./proactive";
import {
  extractConversationReference,
  getTeamFromActivity,
  getTenantId,
  isPersonalConversation,
} from "./teams";

/**
 * Dedupes welcome DMs when Teams fires both installationUpdate
 * and membersAdded for the same install. Fine for MVP single-instance.
 */
const welcomeSent = new Set<string>();

function helpText(): string {
  return [
    "Blue Standup Bot sends weekday standup reminder DMs.",
    "",
    "Configure standups in the Standups channel tab — anyone on the team can create or edit reminders there.",
    "Chat commands are no longer used for configuration.",
  ].join("\n");
}

export class StandupBot extends TeamsActivityHandler {
  constructor() {
    super();

    this.onInstallationUpdateAdd(async (context, next) => {
      await this.sendInstallWelcome(context);
      await next();
    });

    this.onMembersAdded(async (context, next) => {
      const botId = context.activity.recipient?.id;
      for (const member of context.activity.membersAdded ?? []) {
        if (member.id === botId) {
          await this.sendInstallWelcome(context);
        }
      }
      await next();
    });

    this.onMessage(async (context, next) => {
      await this.rememberConversation(context);
      await context.sendActivity(MessageFactory.text(helpText()));
      await next();
    });
  }

  private async sendInstallWelcome(context: TurnContext): Promise<void> {
    const team = getTeamFromActivity(context);
    const userAadId = context.activity.from?.aadObjectId;
    if (!team || !userAadId) {
      return;
    }
    const tenantId = getTenantId(context);
    const dedupeKey = `${tenantId}:${team.id}:${userAadId}`;
    if (welcomeSent.has(dedupeKey)) {
      return;
    }
    welcomeSent.add(dedupeKey);

    const teamLabel = team.name || "your team";
    const message = [
      `Hi! Thanks for installing Blue Standup Bot for ${teamLabel}.`,
      "",
      "Open the Standups tab in a channel to create and manage standup reminders.",
      "Anyone on the team can configure standups — there is no single owner.",
    ].join("\n");

    try {
      await sendProactiveDm({
        tenantId,
        userAadId,
        message,
        serviceUrl: context.activity.serviceUrl,
      });
      console.info(
        `[sendInstallWelcome] sent teamId=${team.id} user=${userAadId}`
      );
    } catch (err) {
      welcomeSent.delete(dedupeKey);
      console.error(
        `[sendInstallWelcome] failed teamId=${team.id} user=${userAadId}`,
        err
      );
    }
  }

  private async rememberConversation(context: TurnContext): Promise<void> {
    if (!isPersonalConversation(context.activity.conversation)) {
      return;
    }
    const aadId = context.activity.from?.aadObjectId;
    const tenantId = getTenantId(context);
    if (!aadId || !tenantId) {
      return;
    }
    const ref = extractConversationReference(context);
    await upsertConversationRef({
      userAadId: aadId,
      tenantId,
      conversationRef: JSON.stringify(ref),
    });
  }
}

export function createBot(): StandupBot {
  return new StandupBot();
}
