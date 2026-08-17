import { prisma } from "../../lib/prisma";
import { renderString, renderJson } from "./render";
import { matchCondition } from "./condition";
import { resolveAudience, type AudienceSpec } from "./audience";
import { deliver } from "./deliver";
import type { NotificationContext } from "./events";

/**
 * Run the engine for an event and RESOLVE when done — never throws (a notification
 * failure must not break the request that triggered it). AWAIT this on serverless
 * (Vercel), where fire-and-forget work after the response can be frozen before it
 * runs. The Expo call itself is time-bounded (see lib/expo-push), so awaiting can't
 * hang the caller.
 */
export async function dispatchEvent(event: string, ctx: NotificationContext): Promise<void> {
  try {
    await dispatch(event, ctx);
  } catch (err) {
    console.error(`[notifications] dispatch failed for "${event}":`, err);
  }
}

/** Fire-and-forget wrapper (for long-running / non-serverless callers). */
export function emit(event: string, ctx: NotificationContext): void {
  void dispatchEvent(event, ctx);
}

async function dispatch(event: string, ctx: NotificationContext): Promise<void> {
  const rules = await prisma.notificationRule.findMany({
    where: { event, enabled: true },
    orderBy: { priority: "desc" },
  });
  if (rules.length === 0) {
    // Rules are DATA (seeded by notifications:seed, editable from the admin
    // console) — an event firing into a database with no enabled rule for it is
    // the classic silent way this feature dies in production, indistinguishable
    // from success without this line. Warn, don't throw: the caller's request
    // must never break on a notification gap.
    console.warn(`[notifications] "${event}" fired but no enabled rule matches — was notifications:seed run?`);
    return;
  }

  const vars = ctx as Record<string, unknown>;

  for (const rule of rules) {
    if (!matchCondition(rule.condition, vars)) continue;

    const template = await prisma.notificationTemplate.findUnique({ where: { key: rule.templateKey } });
    if (!template || !template.active) {
      console.warn(
        `[notifications] rule ${rule.id} (${event}) points at template "${rule.templateKey}" which is ${template ? "inactive" : "missing"} — nothing sent`,
      );
      continue;
    }

    const targets = await resolveAudience(rule.audience as unknown as AudienceSpec, ctx);
    if (targets.length === 0) {
      // The other silent death: the rule matched, the template exists, and the
      // audience resolved to nobody — usually a PushToken whose deviceId no
      // longer matches the Device row, or every token invalidated. Name the
      // user so the delivery table's absence of rows has a paper trail.
      console.warn(
        `[notifications] rule ${rule.id} (${event}) resolved an empty audience for user ${ctx.userId ?? "?"} — no valid push token matched`,
      );
      continue;
    }

    const payload = {
      title: renderString(template.title, vars),
      body: renderString(template.body, vars),
      data: (template.data == null ? undefined : renderJson(template.data, vars)) as
        | Record<string, unknown>
        | undefined,
    };
    const dedupeKey = rule.dedupeKeyTemplate ? renderString(rule.dedupeKeyTemplate, vars) : null;

    await deliver(targets, payload, { source: `rule:${event}`, dedupeKey });
  }
}
