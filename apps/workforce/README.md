# Merit Workforce — the phone app

One app for iPhone and Android for field and shop employees. It is built with Expo (SDK 58,
React Native 0.88, Expo Router, TypeScript strict).

- **Merit Projects** supplies the field work: today's jobs, clock in and out, daily log, photos,
  checklists, punch list and crew time.
- **Merit Books** supplies pay, commissions and receipts (the Me tab). Those cards show only when
  the company has Merit Books.
- The app never shows job money: no contract values, costs, budgets, margins or pay rates. The only
  amounts on the phone are the customer-facing prices a technician presents at the kitchen table,
  the person's **own** pay (installer pay this week, Books pay cards), and an approval amount the
  approvals engine shows only to someone allowed to see it.

## Screens

| Where | What |
|---|---|
| **Today** | The current visit with one big clock button; site notes (gate / lockbox / alarm codes, pets, work hours, parking, off-limits rooms, lead-safe rules, deliveries today); buttons for what the job has: **Show the options**, **Drawings (n)**, **Customer sign-off**, **My repair orders**. |
| **Approve** tab | Everything waiting on me from the approvals engine (change orders, POs, billing, draws, estimates, deals, time) — one card each with Approve / Send back — then my crew's submitted hours. Shows for supervisors and anyone with items waiting; badge = count. |
| **Inbox** (bell) | My notifications from Projects and Books; tap to open the matching screen; Done / Mark all read. Push notifications open the same screens. |
| **Drawings** | The current set of my jobs, saved on the phone (one file per revision; superseded sheets are deleted). Opens in the phone's PDF viewer with no signal; iOS swipes through the set. |
| **Options** (sell) | Good / better / best with regular and member price, rebate and monthly financing payment; add-ons; financing plan; membership on the spot; customer signature; deposit by text pay link, check or cash. |
| **Customer sign-off** | Pick a PDF on the job, hand the phone over; the customer reads it (saved on the phone), agrees, types their name and signs (e-sign with audit certificate). |
| **My repair orders** | Dealer technician: clock on / off / switch per RO line, indirect time, complaint · cause · correction by voice (the keyboard microphone). |
| **Station mode** | A shop tablet: badge + PIN, the worker's operations, Start / Pause / Stop / Done with good and scrap counts, indirect time; signs out after 45 s idle. Once on it stays on (restarts, push taps and deep links return to it); leaving needs the tablet's own screen lock, and a tablet without one leaves only by signing the station seat out. A seat that is only a station never sees anything else. |
| **My pay this week** | Flooring installer: my own pay tickets, split, chargebacks, approved so far. |
| **Visit tools** | Field service: checklists with readings (missing / out of range / red tag checked on the phone), the visit note by voice, equipment from the nameplate. |
| **Will-call pickups** | The POs waiting for me at a supply house with the pickup code; "I picked these up" puts the parts (and serials) on my truck. |
| **Install day** | Flooring installer: today's bookings, rooms, cut list, site checks, "on my way", customer sign-off with after photos, on-site change from the job's labor codes, leftover roll goods. |
| **Snap a receipt** | Residential crew: photo of a receipt for the job (works offline). |

The app is in `apps/workforce/mobile`. That folder has its own `node_modules` and lockfile and is
**not** part of the monorepo's npm workspaces. Root `npm install` and the Vercel builds for Merit Books
and Merit Projects never see React Native. (The root `apps/*` glob skips a folder that has no
`package.json`, and `apps/workforce` has none.)

## What works offline

- The phone keeps today plus the next two days of your assigned work, the jobs and their site
  locations, cost codes, checklists, open punch items and your week of hours. It refreshes when it
  can and shows the saved copy when it can't.
- **Every write is saved on the phone first.** Clock punches, logs, checklists, punch items,
  crew approvals, corrections — and since Wave C: approval decisions, inbox read / done marks,
  station taps, repair-order clock taps and 3C stories, customer signatures, field-service sales
  and declines — go into a queue on the phone (SQLite). Each one keeps the time it
  happened and the GPS fix from that moment. The queue sends when there is signal.
- Every command has its own id, and the server applies each id at most once. So re-sending after a
  dropped connection never creates a second copy.
- Photos are written to the app's own storage before they are queued. Then they upload one at a
  time.
- The badge at the top of every screen says **All saved**, **3 waiting**, or **2 not saved**. Tap it
  to see what is waiting. If the office refused something, it shows the reason in plain words, with
  Try again and Clear.
- **Encrypted on the phone.** The queue and the saved work are encrypted with a 256-bit key that
  exists only in the phone's key store (Keychain / Keystore). Development and store builds also
  encrypt the whole database file with SQLCipher; Expo Go doesn't have SQLCipher, but the contents
  are still sealed with AES-256-GCM. Signing out deletes the database, the photos and the key.
  Photos, drawn signatures, the drawing set and a document being signed sit in the app's private
  storage: on iOS with the strongest file protection (NSFileProtectionComplete — unreadable while
  the phone is locked), on Android in app-private storage under the device's encryption, never in
  backups. The app does not seal these files itself (the PDF viewer and uploads need plain files);
  a signed document is deleted from the phone as soon as it is signed.
- Also saved for offline: my approvals queue, my inbox, today's site notes, the field-service
  options of a visit, my repair orders, my pay this week, and the current drawing set.
- Field-service tools and the sale (with the time the customer signed) queue to
  `POST /api/field/fs-commands`; installer on-my-way, sign-off (with leftover roll goods) and
  on-site change to `POST /api/field/flooring`; receipts to `POST /api/field/receipts` behind their
  photo; the 3C story to `POST /api/field/ro/story`. Each carries its command id and the server
  applies it once. A command that names photos waits for them and sends their document ids.
- What needs signal once: badge + PIN at a station (the lockout lives on the server), and
  starting a customer sign-off (the office makes the one-time signing request and the document).
  After that, taps and the signature are queued like everything else.
- The dealer clock keeps the time the tech tapped. The office refuses a tap that is too old,
  ahead of the real time or overlapping another punch; the phone shows why and never re-sends it.
- Conflict rule: **what the worker recorded wins until the time is approved.** After approval, a
  late change is refused, and the phone says "ask your supervisor to unapprove it".

## Run it on your own phone today (Expo Go, about 10 minutes)

1. Install **Expo Go** from the App Store or Google Play.
2. On a computer with Node 20 or newer:
   ```bash
   cd apps/workforce/mobile
   npm install
   cp .env.example .env      # then fill in the three values below
   npx expo start
   ```
3. Scan the QR code with the phone's camera (iPhone) or with Expo Go (Android).

`.env` values (all three are public by design; never put a Clerk **secret** key here):

| Variable | What it is |
|---|---|
| `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` | The `pk_live_…` / `pk_test_…` key of the **same Clerk instance** Merit Books and Merit Projects use |
| `EXPO_PUBLIC_PROJECTS_API` | The Merit Projects web address, e.g. `https://<your-projects-app>.vercel.app` |
| `EXPO_PUBLIC_BOOKS_API` | The Merit Books web address, e.g. `https://meritbooks-web.vercel.app`. Leave it empty if the company has no Merit Books. |

Expo Go is fine for trying the app. For real crews, use a build (below). A build has its own icon,
its own name on the home screen, and permission prompts in your words.

## Development build (optional, for testing a real install)

```bash
npm install -g eas-cli
eas login
eas init                          # links the app to your Expo account (writes the project id)
eas build --profile development --platform android   # or ios
npx expo start --dev-client
```

## Tests

```bash
cd apps/workforce/mobile
npm test            # queue, clock steps, week overlay, job-by-location, EN/ES strings, push links,
                    # approvals, financing payment, drawings cache plan, station, RO clock, inbox, e-sign
npm run type-check
```

The server side of the contract is tested in Merit Projects (`apps/projects/src/app/api/field/_tests`).

## What Mike needs to do to put it on phones

You only do these once.

1. **Apple Developer Program** ($99 a year): enroll at developer.apple.com as the company, not as a
   person. It needs a D-U-N-S number, and approval can take a few days. After that, create the app
   in **App Store Connect** with the bundle id `com.meritsuite.workforce`. You can change the id in
   `mobile/app.json` before the first build, but not after.
2. **Google Play Console** ($25, one time): sign up at play.google.com/console as an organization.
   Create the app with the package name `com.meritsuite.workforce`. New organization accounts must
   pass Google's identity check first.
3. **Expo account** (free to start) at expo.dev. Then run `eas login` and `eas init` once in
   `apps/workforce/mobile`.
4. **Put the three addresses and keys into EAS**: expo.dev → the project → Environment variables.
   Set `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`, `EXPO_PUBLIC_PROJECTS_API` and `EXPO_PUBLIC_BOOKS_API`
   for the "preview" and "production" environments. Use the **production** Clerk key for production.
5. **Clerk dashboard** (same instance as the web apps):
   - Under User & authentication, turn on **Email verification code** and **SMS verification code**
     as sign-in methods.
   - Make sure each employee is invited with the email or mobile number they will type.
   - Add each employee to the company's organization. The app signs in to the person's
     organization automatically.
6. **Build and send to testers:**
   ```bash
   eas build --profile preview --platform android    # an .apk you can text to Android testers
   eas build --profile production --platform ios      # then: eas submit -p ios  → TestFlight
   ```
   Add testers in TestFlight (iPhone) or as an internal testing track in Play Console (Android).
7. **Release to the stores** when you're happy:
   ```bash
   eas build --profile production --platform all
   eas submit --platform all
   ```
   Apple's review usually takes 1–3 days. Both stores ask for a privacy policy URL. They also ask
   what the app collects: location only at the moment of a punch, photos you take, your name and
   your work email or phone number.

Each new version is another `eas build` + `eas submit` (EAS bumps the build number). Over-the-air
updates (`expo-updates`) can be added later so small fixes skip the store review.

## Notes for the server teams

- Merit Projects field API: `apps/projects/src/app/api/field/**` (today, sync, clock, time, logs,
  photos, checklists, punch, crew, crew/approve; Wave C: extras, drawings, sell, ro, pay, sign).
  Every route uses `route()` with an access grant and runs on the RLS client. `sell` (customer
  prices, never cost or dealer fee) and `pay` (the caller's own tickets only) carry amounts; the
  rest return no money fields.
- The Wave C writes ride `POST /api/field/sync` as v2 commands (`_lib/phone-contract.ts`):
  `approval.decide`, `notification.mark`, `kiosk.event`, `ro.clock`, `ro.story`, `esign.sign`,
  `fs.sell`, `fs.decline` — each applied at most once.
- Push needs an EAS project id (`eas init`) and, for iOS, the push key Expo asks for on the first
  `eas build`. The app registers after sign-in and unregisters on sign-out.
- Station mode runs on a tablet: `supportsTablet` is on, so the iPad needs App Store screenshots.
- Bearer tokens: both web apps use `clerkMiddleware`, which accepts `Authorization: Bearer <session
  token>`. An expired token gets a **404 page** (Clerk's `auth.protect()` behaviour for non-page
  requests), not a 401. The app treats that as "refresh the token and try again once". No
  middleware change is required.
