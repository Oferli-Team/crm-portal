import { grep, report } from "./lib.mjs";

// A NEXT_PUBLIC_-prefixed service-role/secret variable would be inlined
// into the client bundle at build time — this check catches the mistake at
// its source (an env var name) rather than only after a build.
const pattern = "NEXT_PUBLIC_[A-Z_]*(SERVICE|SECRET)";
const matches = [
  grep(pattern, "src/"),
  grep(pattern, "next.config.ts"),
  grep(pattern, ".env.example"),
].join("");
const passed = report("no NEXT_PUBLIC_*SERVICE|SECRET variable referenced anywhere", matches === "", matches);
process.exit(passed ? 0 : 1);
