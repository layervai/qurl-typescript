import { execFileSync } from "node:child_process";

// Check tracked text files without following symlinks or printing matched values.
let matches;
try {
  matches = execFileSync(
    "git",
    [
      "--no-pager",
      "grep",
      "--no-textconv",
      "-I",
      "-l",
      "-z",
      "-E",
      "lv_(live|test)_[A-Za-z0-9_-]+",
      "--",
      ".",
    ],
    { encoding: "utf8" },
  );
} catch (error) {
  if (error.status !== 1) throw error;
  matches = "";
}
for (const file of matches.split("\0").filter(Boolean)) {
  console.error(`${JSON.stringify(file)}: secret-shaped fixture; use test-api-key or YOUR_API_KEY`);
  process.exitCode = 1;
}
