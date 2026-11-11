# Passbook

A family savings book for kids. Parents hold the real money; Passbook keeps the ledger. Each kid gets their own balance, a weekly allowance that pays itself, parent-paid interest, and a savings goal. Kids sign in with a family code and a PIN, and they can ask to add or spend money. Parents approve.

No bank connection, no fees, no third party holding your kids' data. It runs on your own Firebase project, and typical family usage stays inside the free tier.

## How the money works

Passbook is an IOU ledger. When it says Ava has $27.00, that means you owe Ava $27.00. Nothing moves between bank accounts. If you want the IOU fully backed, keep a separate savings account and top it up to match the total of all balances.

Interest is paid by you, so set it with care. A high rate is a great teaching tool on small balances; use the interest cap ("only pay interest on the first $X") so a big balance doesn't compound into a big bill.

## Features

- Any number of kids per family, each with their own PIN
- Weekly allowance per kid: amount and payday set by a parent, paid automatically
- Interest set by the parent: pick a preset ("1% each month", "5% on the first $100") or set your own rate, period, and cap
- Kids request deposits or withdrawals; parents approve or deny
- A chore list: parents set chores and what they pay; kids tap "I did a chore" and parents approve
- Savings goals with a progress bar
- A passbook-style transaction history for every account
- Installable on phones as a home-screen web app
- Works on phones, tablets, and desktops: layouts adapt to the space available, and the passbook turns into easy-to-read cards on small screens

### A clean dashboard for parents

Parents get a calm, professional dashboard: a summary row (total held, requests waiting, weekly allowance, next payout), an approval queue, and a card per saver with the common actions up front. Kids keep their own colorful, playful pages. The two looks are kept separate by a `data-role` attribute on `<html>`, so styling one can't change the other.

### Made for kids

- **Decorate my page.** Each kid picks a buddy (an animal avatar), one of 10 colors, a background pattern, and up to 8 stickers. Their whole page, including the top bar and buttons, switches to their colors. Parents can decorate a kid's page too, from the **Decorate** button on that kid's card.
- **Readable in every color.** Every color theme is checked for at least 4.5:1 text contrast, in light and dark mode.
- **Spot yourself.** Kids see their buddy next to their name on the sign-in screen, and parents see each kid's color and buddy on their card.
- **Goal confetti.** When a kid's savings reach their goal, their stickers rain down once to celebrate. It's skipped on devices set to reduce motion.

### Made for non-technical families

- **Getting-started checklist** on the parent screen: add savers, pick allowance/interest, add chores, send the sign-in link.
- **Sign-in link for kids.** "Send sign-in link" opens the phone's share sheet (or copies the link). Kids open it and the family code is already filled in; they just tap their name and type their PIN.
- **No typing amounts.** Every money form has one-tap amounts ($1, $5, $10, $20), chore buttons that fill in amount and description, and suggested descriptions.
- **Give to several at once** (holiday gifts, a shared chore) in one step.
- **Readable PINs.** When adding a saver, the PIN is shown so you can write it down, and "Make one up" picks one for you.
- **Your time zone, automatically.** Detected from your browser when you create the family; change it in settings.
- **Download as a spreadsheet.** Any passbook, or the whole family, as a CSV that opens in Excel, Numbers, or Google Sheets.
- **Notifications and logging with no code.** Paste a Zapier, Make, or IFTTT webhook address in settings to get a text or email when a kid asks for something, or to add every entry to a Google Sheet. See [Notifications](#notifications-zapier-make-ifttt).

## Architecture

```
public/          Static web app (no build step). Firebase JS SDK from the CDN.
functions/       Cloud Functions (Node 22). Every write goes through these.
  lib/core.js    Pure logic: dates, interest, validation (unit tested)
firestore.rules  Read-only access, scoped by custom claims
test/e2e.mjs     End-to-end test against the emulators
```

**Security model.** Browsers can only read. Balances, ledger entries, and requests are written by Cloud Functions, so a kid with dev tools can't give themselves money, and neither can a parent by accident. Parents sign in with email and password and get a `role: parent` custom claim when they create a family. Kids sign in in two steps: the device signs in anonymously (which by itself can read nothing), then `kidLogin` checks a scrypt-hashed PIN (locks for 15 minutes after 5 misses) and sets `role: kid`, `familyId`, and `kidId` custom claims on that anonymous account. Anonymous accounts can't create a family, and signing out deletes the kid's anonymous account. This needs no extra Google Cloud permissions. Firestore rules let kids read only their own account and requests. PIN hashes live in `kidSecrets`, which no client can read.

**Data model.**

```
codes/{familyCode}                         -> { familyId }
families/{fid}                             name, code, timeZone, interestRatePct, interestPeriod, interestCapCents, chores[]
families/{fid}/private/settings            webhookUrl (parents can read; kids can't)
families/{fid}/kids/{kidId}                name, balanceCents, allowanceCents, allowanceDay, goal, look, archived
families/{fid}/kids/{kidId}/transactions   type, amountCents (signed), balanceAfterCents, memo, by, createdAt
families/{fid}/kidSecrets/{kidId}          pinHash, failedAttempts, lockedUntil
families/{fid}/requests/{id}               kidId, kind, amountCents, memo, choreId, status
```

All money is stored as integer cents. Interest rounds down to the cent.

**Payouts.** `dailyPayouts` runs every hour at :05. Each family is paid on the first run at or after 6 AM in that family's own time zone. For each kid it pays interest (if due today) and then allowance (if today is their payday), inside a Firestore transaction. Each payout is stamped (`lastInterestKey`, `lastAllowanceDate`), so the later runs that day pay nothing. Parents can trigger the same job from the settings screen.

**Looks.** `look` is `{ theme, pattern, avatar, stickers[] }`, set by `setLook` (a kid for themselves, or a parent for any kid). The server accepts only values from fixed lists in `functions/lib/core.js`. `public/looks.js` holds the same lists plus colors, and a unit test keeps the two in sync.

**Chores.** A chore request carries only the chore's id. The function looks up the name and amount from the parent's list, so a kid can't change what a chore pays.

## Setup

You need Node 22 and the Firebase CLI (`npm i -g firebase-tools`).

1. **Create a Firebase project** at console.firebase.google.com. Upgrade it to the Blaze plan, which Cloud Functions and scheduled jobs require. Normal family use costs nothing, but you can set a budget alert to be sure.
2. **Turn on sign-in.** Under Authentication, click **Get started** if you see it. Then under Sign-in method, turn on **Email/Password** (for parents) and **Anonymous** (for kids' PIN sign-in).
3. **Create a Firestore database** in production mode.
4. **Register a web app** under Project settings > Your apps (any nickname, tick "Also set up Firebase Hosting"). You don't need to copy the config anywhere: Firebase Hosting gives the app its config automatically.
5. **Point the CLI at your project.** Copy `.firebaserc.example` to `.firebaserc` and set your project ID, or run `firebase use --add`.
6. **Deploy.**

   ```sh
   npm --prefix functions install
   firebase deploy
   ```

Open the Hosting URL, create a parent account, and create your family. The getting-started list walks you through the rest. Use **Send sign-in link** to text your kids the link, and tell each one their PIN.

Hosting somewhere other than Firebase Hosting, or deploying functions to a region other than `us-central1`? Copy `public/firebase-config.example.js` to `public/firebase-config.js` and fill it in; it overrides the automatic config. Time zones are set per family in the app; `FAMILY_TIMEZONE` in `functions/.env` is only a fallback for families created before that existed.

## Notifications (Zapier, Make, IFTTT)

In **Interest & settings > Notifications**, paste a webhook address and press **Send a test**. Passbook POSTs JSON to it:

| Event | When |
| --- | --- |
| `request.created` | A kid asks to add or spend money, or taps a chore |
| `entry.posted` | Any money moves: parent entry, approved request, allowance, interest |
| `test` | You press Send a test |

Every event has the same flat fields, so they're easy to map in Zapier: `event`, `family`, `saver`, `summary` (a ready-to-send sentence), `kind`, `amount` and `balance` (like `"5.00"`), `amountCents`, `balanceCents`, `memo`, `at` (ISO time). `request.created` also has `requestId`; `entry.posted` also has `by` (`parent`, `request`, or `system`).

**Example Zap: text me when a kid asks for money.** Trigger: *Webhooks by Zapier > Catch Hook*; copy its URL into Passbook and press Send a test. Filter: `event` exactly matches `request.created`. Action: *SMS by Zapier* (or Gmail, Slack) with the message set to `summary`.

**Example Zap: log every entry to Google Sheets.** Same trigger, filter on `entry.posted`, action *Google Sheets > Create Spreadsheet Row* mapping `at`, `saver`, `kind`, `memo`, `amount`, `balance`.

The address must be `https://`. It's stored where only parents can read it. Delivery is best effort: one try, with an 8-second timeout.

## Local development

```sh
npm install                      # client SDK for the e2e test
npm --prefix functions install

npm run dev        # emulators + hosting at http://localhost:5000
npm test           # unit tests for lib/core.js, the CSV export, and kid looks
npm run test:e2e   # full flow against the emulators
```

GitHub Actions (`.github/workflows/test.yml`) runs the unit tests and the emulator e2e test on every pull request and every push to `main`.

On `localhost` the web app connects to the emulators automatically, and the Hosting emulator serves the config. The e2e test pins "today" with an `asOf` value (accepted only by the emulator), so it passes on any day of the week.

## Known limits and roadmap

- One parent account per family. A co-parent invite flow is the next obvious addition.
- Missed days aren't back-filled. If the scheduler is down on payday, that week's allowance is skipped; pay it by hand with Add money.
- `listKidsForCode` and `kidLogin` are public callables, protected by the 6-character code and PIN lockout. Turn on Firebase App Check before opening this to many families.
- Notifications go through your own webhook (Zapier, Make, IFTTT). There's no built-in email or push yet.

## License

MIT. See [LICENSE](LICENSE).
