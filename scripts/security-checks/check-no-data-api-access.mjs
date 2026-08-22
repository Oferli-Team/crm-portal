import { grep, report } from "./lib.mjs";

// This app is Prisma-only by design (see the Stage 2A Data API lockdown) —
// any direct supabase.from(...) call would be reading/writing through the
// PostgREST Data API instead, bypassing that trust boundary entirely.
const matches = grep("supabase\\.from\\(", "src/");
const passed = report("no supabase.from( (Data API) usage in src/", matches === "", matches);
process.exit(passed ? 0 : 1);
