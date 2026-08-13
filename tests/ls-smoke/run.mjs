// The runner. Prints NOT RUN and exits 0 when credentials are absent, so it can
// sit in CI without ever going red for a reason that is not a defect.
import { checkEnvGuards, checkKeyIsTestMode } from "./guards.ts";
const g = checkEnvGuards(process.env);
if (!g.ok) {
  console.log(`NOT RUN — missing Test Mode credentials (${g.reason})`);
  process.exit(0);
}
const key = await checkKeyIsTestMode(process.env.LEMONSQUEEZY_API_BASE ?? "https://api.lemonsqueezy.com", process.env.LEMONSQUEEZY_API_KEY);
if (!key.ok) {
  console.error(`REFUSED — ${key.reason}`);
  process.exit(1);
}
console.log("guards passed — read-only Test Mode checks would run here");
