import { app, InvocationContext, Timer } from "@azure/functions";
import { sendProactiveDm } from "../bot/proactive";
import { currentUtcHhMm, isWeekdayUtc } from "../config";
import { listDueConfigs } from "../db/client";

async function sendReminder(params: {
  tenantId: string;
  userAadId: string;
  message: string;
  context: InvocationContext;
}): Promise<void> {
  const { tenantId, userAadId, message, context } = params;
  await sendProactiveDm({ tenantId, userAadId, message });
  context.log(`Notified ${userAadId}`);
}

async function notify(
  _timer: Timer,
  context: InvocationContext
): Promise<void> {
  if (!isWeekdayUtc()) {
    context.log("Skipping notify: weekend (UTC).");
    return;
  }

  const hhmm = currentUtcHhMm();
  context.log(`Notify tick at ${hhmm} UTC`);

  let due;
  try {
    due = await listDueConfigs(hhmm);
  } catch (err) {
    context.error("Failed to load due configs", err);
    return;
  }

  if (due.length === 0) {
    context.log("No configs due this minute.");
    return;
  }

  for (const config of due) {
    context.log(
      `Sending reminders for config ${config.id} (${config.users.length} users)`
    );
    for (const user of config.users) {
      try {
        await sendReminder({
          tenantId: config.tenantId,
          userAadId: user.userAadId,
          message: config.message,
          context,
        });
      } catch (err) {
        context.error(
          `Failed to notify user ${user.userAadId} for config ${config.id}`,
          err
        );
      }
    }
  }
}

app.timer("notify", {
  schedule: "0 * * * * *",
  handler: notify,
});
