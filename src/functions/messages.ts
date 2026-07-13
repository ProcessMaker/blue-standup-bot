import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import type { Activity } from "botbuilder";
import { getAdapter } from "../bot/teams";
import { createBot } from "../bot/standupBot";

const bot = createBot();

export async function messages(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  try {
    const adapter = getAdapter();
    const body = (await request.json()) as Activity;
    const authHeader = request.headers.get("authorization") ?? "";

    await adapter.processActivityDirect(authHeader, body, async (turnContext) => {
      await bot.run(turnContext);
    });

    return { status: 200 };
  } catch (err) {
    context.error("messages handler error", err);
    return { status: 500, body: "Internal Server Error" };
  }
}

app.http("messages", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "messages",
  handler: messages,
});
