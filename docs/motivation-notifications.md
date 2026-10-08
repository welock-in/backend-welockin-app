# Motivational reminders

The mobile app reports its IANA timezone and app language on boot and foreground.
That first report creates an account preference with reminders enabled and all
seven weekdays selected. The iOS notification permission is still required for
delivery. The profile's Notifications screen lets the user switch motivational
messages off or choose weekdays without affecting focus or device alerts.

The scheduler picks one stable minute per user and local date between 17:35 and
19:15, excluding `:00` and `:30`. The minute changes from day to day. The cron
checks due preferences every minute and sends to one registered iOS phone. It
skips a stale slot, a session already recorded that day, or a live session. A
unique `(userId, localDate)` send claim prevents duplicate sends if cron runs
twice or overlaps. Accepted Expo tickets are recorded through the existing
notification delivery path; Expo receipts remain the delivery diagnostic.

## Production order

1. The backend creates the new collections' indexes additively on the first
   settings registration or cron invocation. When direct database access is
   available, verify them with:

   ```sh
   npm run motivation:indexes
   ```

   The script reads `DATABASE_URL`. It never prints the credential. Do not use
   `prisma db push` on production MongoDB for this rollout. The automatic
   installer fails closed if MongoDB rejects index creation.
2. Deploy the backend code and the new cron route. There are no preference rows
   until a new mobile client reports its context.
3. Release the mobile client. A development build on a physical iPhone is needed
   to exercise remote push and the Screen Time session entry path.
4. Confirm one test account's next local time, send, Expo ticket/receipt, tap,
   disabled state, and weekday selection before broad release.

The scheduled minute is the target. The operating system and push provider may
present the notification later. Pushes expire after one hour to limit late
delivery. A focus session completed entirely offline may be unknown to the
server until its queued event syncs; that case cannot be suppressed reliably by
a server-sent notification while the phone remains offline.
