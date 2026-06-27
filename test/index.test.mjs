import test from "node:test";
import assert from "node:assert/strict";
import {
  conductorPath,
  expandHome,
  parseArgs,
  parseBranchPrefix,
  slugify,
  timestampSlug,
} from "../index.mjs";

test("slugify normalizes names for branch and path usage", () => {
  assert.equal(slugify("  My Feature / V2!  "), "my-feature-v2");
  assert.equal(slugify("___"), "workspace");
});

test("timestampSlug uses stable local timestamp formatting", () => {
  assert.equal(timestampSlug(new Date(2026, 5, 27, 9, 4, 5)), "herdr-test-20260627-090405");
});

test("parseBranchPrefix reads Conductor branch prefix", () => {
  const toml = `
[git]
branch_prefix = "user/"
branch_prefix_type = "custom"
`;
  assert.equal(parseBranchPrefix(toml), "user/");
  assert.equal(parseBranchPrefix("[git]\narchive_on_merge = false\n"), "");
});

test("conductorPath places workspace under repo-named Conductor directory", () => {
  const path = conductorPath("/path/to/repos/example", "trial", "/tmp/conductor/workspaces");
  assert.equal(path, "/tmp/conductor/workspaces/example/trial");
});

test("expandHome expands tilde paths", () => {
  assert.match(expandHome("~/conductor/workspaces"), /\/conductor\/workspaces$/);
  assert.equal(expandHome("/tmp/x"), "/tmp/x");
});

test("parseArgs supports explicit trial parameters", () => {
  assert.deepEqual(parseArgs(["create", "--cwd", "/repo", "--slug", "Trial", "--dry-run"]), {
    command: "create",
    cwd: "/repo",
    slug: "Trial",
    conductorRoot: "~/conductor/workspaces",
    dryRun: true,
  });
});
