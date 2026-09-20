/** The device-id prefixes emitted by the Windows and macOS applications. */
export function isDesktopDeviceId(deviceId: string): boolean {
  return /^(?:win|mac)-\S+$/.test(deviceId);
}

/**
 * A saved grant applies only to desktop requests, independent of the signup
 * offer's current flag. It never grants mobile access or represents a payment.
 */
export function hasDesktopLifetime(
  user: { desktopLifetimeGrantedAt?: Date | null } | null,
  deviceId: string,
): boolean {
  return user?.desktopLifetimeGrantedAt != null && isDesktopDeviceId(deviceId);
}
