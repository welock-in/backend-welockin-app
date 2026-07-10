import type { Prisma } from "@prisma/client";

/** Match both explicit null and fields absent from pre-mobile Mongo documents. */
export function legacyNameOnlyDeviceWhere(userId: string, name: string): Prisma.DeviceWhereInput {
  return {
    userId,
    name,
    OR: [{ deviceId: null }, { deviceId: { isSet: false } }],
  };
}
