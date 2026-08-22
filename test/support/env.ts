import { config as loadDotenv } from "dotenv";
import { existsSync } from "fs";
import { resolve } from "path";

// .env.test lets a contributor point the suite at a local Supabase stack
// (or a dedicated test project) without touching the app's own .env — falls
// back to .env only so the DB/Supabase vars already configured for local
// dev still work until .env.test exists (added once the local stack is
// wired up in a later stage).
const envTestPath = resolve(process.cwd(), ".env.test");
loadDotenv({ path: existsSync(envTestPath) ? envTestPath : resolve(process.cwd(), ".env") });

// Every fixture's email must live on this domain — never a real inbox, and
// never the mailinator-style addresses used for manual QA in prior stages.
export const TEST_EMAIL_DOMAIN = process.env.TEST_EMAIL_DOMAIN ?? "test.local";
