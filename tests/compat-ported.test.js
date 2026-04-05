import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { assertCase, buildCaseGroups } from "./helpers/compat-test-utils.js";

const casesPath = path.resolve(process.cwd(), "tests/compat-cases.json");
const extracted = JSON.parse(fs.readFileSync(casesPath, "utf8"));
const groups = buildCaseGroups(extracted.cases);

for (const [groupName, groupCases] of groups) {
  test(groupName, () => {
    for (const testCase of groupCases) {
      assertCase(testCase);
    }
  });
}
