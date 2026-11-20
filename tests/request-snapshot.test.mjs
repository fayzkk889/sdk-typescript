import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProoflineClient, ProoflineError } from "../dist/index.js";
import { readCoverageFiles } from "../dist/coverage.js";

const originalSha = "a".repeat(40);
const replacementSha = "b".repeat(40);
const org = "00000000-0000-7000-8000-000000000001";
const repo = "00000000-0000-7000-8000-000000000002";
const otherOrg = "00000000-0000-7000-8000-000000000003";
const otherRepo = "00000000-0000-7000-8000-000000000004";

async function coverageFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "proofline-request-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "lcov.info"), "TN:\nSF:src/a.ts\nDA:1,1\nend_of_record\n");
  return { root, tested_sha: originalSha, files: ["lcov.info"] };
}

test("coverage body retains the SHA validated before filesystem I/O", async (t) => {
  const upload = await coverageFixture(t);
  const pending = readCoverageFiles(upload);
  upload.tested_sha = replacementSha;
  const body = await pending;
  assert.equal(body.tested_sha, originalSha);
});

test("coverage upload retains its organization, repository and tested revision", async (t) => {
  const upload = await coverageFixture(t);
  const parameters = { path: { org_id: org, repo_id: repo } };
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return Response.json({ created: true });
  });
  const client = new ProoflineClient({ token: "synthetic-test-token" });
  const pending = client.uploadCoverageFiles(parameters, upload);
  parameters.path.org_id = otherOrg;
  parameters.path.repo_id = otherRepo;
  upload.tested_sha = replacementSha;
  await pending;
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    `https://proofline.sh/api/v1/organizations/${org}/repositories/${repo}/coverage-reports`,
  );
  assert.equal(calls[0].body.tested_sha, originalSha);
});

test("re-verification retains the finding selection captured before MCP negotiation", async (t) => {
  const findings = ["00000000-0000-7000-8000-000000000005"];
  const originalFinding = findings[0];
  const calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-11-25" } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: 2, result: { content: [] } });
  });
  const client = new ProoflineClient({ token: "synthetic-test-token" });
  const pending = client.fixes.requestReverification({
    review_id: repo,
    finding_ids: findings,
    commit_sha: originalSha,
  });
  findings[0] = "00000000-0000-7000-8000-000000000006";
  findings.push("00000000-0000-7000-8000-000000000007");
  await pending;
  assert.deepEqual(calls.at(-1).params.arguments.finding_ids, [originalFinding]);
});

test("a later invalid SHA cannot replace the validated revision", async (t) => {
  const upload = await coverageFixture(t);
  const pending = readCoverageFiles(upload);
  upload.tested_sha = "not-a-commit";
  assert.equal((await pending).tested_sha, originalSha);
});

test("an invalid initial SHA is refused before any request", async (t) => {
  const upload = await coverageFixture(t);
  upload.tested_sha = "not-a-commit";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({});
  });
  const client = new ProoflineClient({ token: "synthetic-test-token" });
  const pending = client.uploadCoverageFiles({ path: { org_id: org, repo_id: repo } }, upload);
  upload.tested_sha = originalSha;
  await assert.rejects(pending, TypeError);
  assert.equal(calls, 0);
});

test("concurrent coverage calls snapshot a reusable target and upload independently", async (t) => {
  const upload = await coverageFixture(t);
  const parameters = { path: { org_id: org, repo_id: repo } };
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), sha: JSON.parse(options.body).tested_sha });
    return Response.json({ created: true });
  });
  const client = new ProoflineClient({ token: "synthetic-test-token" });
  const first = client.uploadCoverageFiles(parameters, upload);
  parameters.path = { org_id: otherOrg, repo_id: otherRepo };
  upload.tested_sha = replacementSha;
  const second = client.uploadCoverageFiles(parameters, upload);
  parameters.path.org_id = repo;
  upload.tested_sha = "c".repeat(40);
  await Promise.all([first, second]);
  assert.deepEqual(calls.sort((a, b) => a.url.localeCompare(b.url)), [
    {
      url: `https://proofline.sh/api/v1/organizations/${org}/repositories/${repo}/coverage-reports`,
      sha: originalSha,
    },
    {
      url: `https://proofline.sh/api/v1/organizations/${otherOrg}/repositories/${otherRepo}/coverage-reports`,
      sha: replacementSha,
    },
  ]);
});

test("concurrent MCP requests retain independent finding selections and refusals", async (t) => {
  const findings = [org];
  const selections = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-11-25" },
      });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    selections.push(body.params.arguments.finding_ids);
    return Response.json({ jsonrpc: "2.0", id: 2, result: { content: [], isError: true } });
  });
  const client = new ProoflineClient({ token: "synthetic-test-token" });
  const args = { review_id: repo, finding_ids: findings, commit_sha: originalSha };
  const first = client.fixes.requestReverification(args);
  findings[0] = otherOrg;
  const second = client.fixes.requestReverification(args);
  findings.length = 0;
  const results = await Promise.all([first, second]);
  assert.deepEqual(selections, [[org], [otherOrg]]);
  assert.ok(results.every((result) => result.isError === true));
  assert.equal(findings.length, 0);
});

test("re-verification still sends one tool request when HTTP refuses it", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.method === "initialize") {
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-11-25" },
      });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    requests += 1;
    return Response.json(
      { title: "temporarily unavailable" },
      { status: 503, headers: { "Retry-After": "0" } },
    );
  });
  const client = new ProoflineClient({ token: "synthetic-test-token" });
  await assert.rejects(
    client.fixes.requestReverification({
      review_id: repo,
      finding_ids: [org],
      commit_sha: originalSha,
    }),
    (error) => error instanceof ProoflineError && error.status === 503,
  );
  assert.equal(requests, 1);
});
