'use client';
/**
 * The shell's notifications bell (PLT-42): the notifications module's NotificationBell (unread
 * count from /api/notifications, popover, "Open inbox"), mounted in the bar beside ⌘K.
 */
import { NotificationBell } from '@/components/notifications/NotificationBell';

/** The bell is part of this build (kept as a flag so the shell can be rendered without it in tests). */
export const hasBell = true;

export function BellSlot() {
  return <NotificationBell />;
}
