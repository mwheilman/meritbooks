export const dynamic = 'force-dynamic';

import { route } from '@/lib/api';
import { registerDevice, unregisterDevice } from '@/lib/notify/inbox';
import { DeviceBody, DeviceDeleteBody } from '@/lib/notify/schemas';

/** POST /api/notifications/devices { token, platform, deviceName, appVersion } — Merit Workforce registers its Expo push token. */
export const POST = route({ access: 'none', body: DeviceBody, mask: false, allowReadOnly: true }, async ({ db, body }) => {
  const id = await registerDevice(db, body);
  return { id };
});

/** DELETE /api/notifications/devices { token } — on sign-out. */
export const DELETE = route({ access: 'none', body: DeviceDeleteBody, mask: false, allowReadOnly: true }, async ({ db, body }) => {
  return { removed: await unregisterDevice(db, body.token) };
});
