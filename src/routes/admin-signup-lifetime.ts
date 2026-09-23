import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAdmin } from "../middleware/admin-auth";
import { asyncHandler } from "../middleware/async-handler";
import {
  readSignupLifetimeSettings,
  SIGNUP_LIFETIME_SETTINGS_ID,
  signupLifetimeSettingsUnavailable,
  signupLifetimeSettingsView,
} from "../lib/signup-lifetime";

export const adminSignupLifetimeRouter = Router();
const patchSchema = z.object({
  iosSignupLifetimeEnabled: z.boolean().optional(),
  desktopSignupLifetimeEnabled: z.boolean().optional(),
}).strict().refine((input) => Object.keys(input).length > 0, "At least one setting is required");

adminSignupLifetimeRouter.get("/", requireAdmin, asyncHandler(async (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ settings: await readSignupLifetimeSettings() });
}));

adminSignupLifetimeRouter.patch("/", requireAdmin, asyncHandler(async (req, res) => {
  const input = patchSchema.parse(req.body);
  const username = req.admin!.username;
  // A concurrent first upsert or a Mongo transaction conflict can be retried.
  // Every retry reads the current row, and UPDATE contains only the sent fields.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const settings = await prisma.$transaction(async (tx) => {
        const before = signupLifetimeSettingsView(await tx.signupLifetimeSettings.findUnique({
          where: { id: SIGNUP_LIFETIME_SETTINGS_ID },
        }));
        const after = signupLifetimeSettingsView(await tx.signupLifetimeSettings.upsert({
          where: { id: SIGNUP_LIFETIME_SETTINGS_ID },
          create: {
            id: SIGNUP_LIFETIME_SETTINGS_ID,
            iosSignupLifetimeEnabled: false,
            desktopSignupLifetimeEnabled: false,
            ...input,
            updatedBy: username,
          },
          update: { ...input, updatedBy: username },
        }));
        await tx.adminAuditLog.create({
          data: {
            actorId: "000000000000000000000000",
            actorEmail: `admin:${username}`,
            action: "signup_lifetime_settings",
            reason: "Update lifetime offers for future signups",
            before,
            after,
          },
        });
        return after;
      });
      res.set("Cache-Control", "no-store");
      res.json({ settings });
      return;
    } catch (error) {
      if (attempt < 2 && error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === "P2002" || error.code === "P2034")) continue;
      throw signupLifetimeSettingsUnavailable();
    }
  }
}));
