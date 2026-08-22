import { grep, report } from "./lib.mjs";

const matches = grep("dangerouslySetInnerHTML", "src/");
const passed = report("no dangerouslySetInnerHTML in src/", matches === "", matches);
process.exit(passed ? 0 : 1);
