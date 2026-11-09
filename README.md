# Passbook

A family savings book for kids. Parents hold the real money; Passbook keeps the ledger. Each kid gets their own balance, a weekly allowance that pays itself, parent-paid interest, and a savings goal. Kids sign in with a family code and a PIN, and they can ask to add or spend money. Parents approve.

No bank connection, no fees, no third party holding your kids' data. It runs on your own Firebase project, and typical family usage stays inside the free tier.

## How the money works

Passbook is an IOU ledger. When it says Ava has $27.00, that means you owe Ava $27.00. Nothing moves between bank accounts. If you want the IOU fully backed, keep a separate savings account and top it up to match the total of all balances.

Interest is paid by you, so set it with care. A high rate is a great teaching tool on small balances; use the interest cap ("only pay interest on the first $X") so a big balance doesn't compound into a big bill.

## Features

- Any number of kids per family, each with their own PIN
- Weekly allowance per kid: amount and payday set by a parent, paid automatically
- Interest set by the parent: rate, weekly (Sunday) or monthly (the 1st), and an optional cap
- Kids request deposits or withdrawals; parents approve or deny
- Savings goals with a progress bar
- A passbook-style transaction history for every account
- Installable on phones as a home-screen web app

## Architecture

```
public/          Static web app (no build step). Firebase JS SDK from the CDN.
functions/       Cloud Functions (Node 22). Every write goes through these.
  lib/core.js    Pure logic: dates, interest, validation (unit tested)
firestore.rules  Read-only access, scoped by custom claims
test/e2e.mjs     End-to-end test against the emulators
```

**Security model.** Browsers can only read. Balances, ledger entries, and requests are written by Cloud Functions, so a kid with dev tools can't give themselves money, and neither can a parent by accident. Parents sign in with email and password and get a `role: parent` custom claim when they create a family. Kids sign in through `kidLogin`, which checks a scrypt-hashed PIN (locks for 15 minutes after 5 misses) and returns a custom token with `role: kid` and their `kidId`. Firestore rules let kids read only their own account and requests. PIN hashes live in `kidSecrets`, which no client can read.

**Data model.**

```
codes/{familyCode}                         -> { familyId }
families/{fid}                             name, code, interestRatePct, interestPeriod, interestCapCents
families/{fid}/kids/{kidId}                name, balanceCents, allowanceCents, allowanceDay, goal, archived
families/{fid}/kids/{kidId}/transactions   type, amountCents (signed), balanceAfterCents, memo, by, createdAt
families/{fid}/kidSecrets/{kidId}          pinHash, failedAttempts, lockedUntil
families/{fid}/requests/{id}               kidId, kind, amountCents, memo, status
```

All money is stored as integer cents. Interest rounds down to the cent.

**Payouts.** `dailyPayouts` runs at 6:05 AM in `FAMILY_TIMEZONE`. For each kid it pays interest (if due today) and then allowance (if today is their payday), inside a Firestore transaction. Each payout is stamped (`lastInterestKey`, `lastAllowanceDate`), so running it twice never pays twice. Parents can trigger the same job from the settings screen.

## Setup

You need Node 22 and the Firebase CLI (`npm i -g firebase-tools`).

1. **Create a Firebase project** at console.firebase.google.com. Upgrade it to the Blaze plan, which Cloud Functions and scheduled jobs require. Normal family use costs nothing, but you can set a budget alert to be sure.
2. **Turn on Email/Password sign-in** under Authentication > Sign-in method.
3. **Create a Firestore database** in production mode.
4. **Register a web app** under Project settings > Your apps, then copy `public/firebase-config.example.js` to `public/firebase-config.js` and paste in the config.
5. **Set your time zone.** Copy `functions/.env.example` to `functions/.env` and set `FAMILY_TIMEZONE` (for example `America/Chicago`).
6. **Point the CLI at your project.** Copy `.firebaserc.example` to `.firebaserc` and set your project ID, or run `firebase use --add`.
7. **Allow kid sign-in tokens to be signed.** In the Google Cloud console under IAM, give the functions runtime service account (`PROJECT_NUMBER-compute@developer.gserviceaccount.com`) the **Service Account Token Creator** role, and enable the **IAM Service Account Credentials API**. Without this, `kidLogin` fails with a signBlob permission error.
8. **Deploy.**

   ```sh
   npm --prefix functions install
   firebase deploy
   ```

Open the Hosting URL, create a parent account, create your family, and add your kids. Give each kid the family code shown at the top of the parent screen and their PIN.

## Local development

```sh
npm install                      # client SDK for the e2e test
npm --prefix functions install
cp public/firebase-config.example.js public/firebase-config.js   # any values work locally
echo "FAMILY_TIMEZONE=America/New_York" > functions/.env

npm run dev        # emulators + hosting at http://localhost:5000
npm test           # unit tests for lib/core.js
npm run test:e2e   # full flow against the emulators
```

On `localhost` the web app connects to the emulators automatically.

## Known limits and roadmap

- One parent account per family. A co-parent invite flow is the next obvious addition.
- One time zone per deployment (`FAMILY_TIMEZONE`).
- Missed days aren't back-filled. If the scheduler is down on payday, that week's allowance is skipped; pay it by hand with Add money.
- `listKidsForCode` and `kidLogin` are public callables, protected by the 6-character code and PIN lockout. Turn on Firebase App Check before opening this to many families.
- No notifications yet. A Firestore trigger on `requests` that emails or texts a parent would be a small addition.

## License

MIT. See [LICENSE](LICENSE).
