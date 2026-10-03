import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPublicProcessDetail,
  buildPublicProcessList,
  derivePublicLifecycle,
} from "../tools/lib/process-search-public.mjs";
import { createRunningPublicationStep, createValidV3Log } from "./fixtures/process-log-v3.mjs";

const stateByCode = Object.freeze({
  P: "pending",
  R: "running",
  B: "blocked",
  F: "failed",
  C: "completed",
  S: "stale",
});

const expectedSiblingAggregate = Object.freeze({
  P: Object.freeze({
    P: "ready",
    R: "running",
    B: "blocked",
    F: "failed",
    C: "ready",
    S: "stale",
  }),
  R: Object.freeze({
    P: "running",
    R: "running",
    B: "running",
    F: "running",
    C: "running",
    S: "running",
  }),
  B: Object.freeze({
    P: "blocked",
    R: "running",
    B: "blocked",
    F: "failed",
    C: "blocked",
    S: "stale",
  }),
  F: Object.freeze({
    P: "failed",
    R: "running",
    B: "failed",
    F: "failed",
    C: "failed",
    S: "stale",
  }),
  C: Object.freeze({
    P: "ready",
    R: "running",
    B: "blocked",
    F: "failed",
    C: "complete",
    S: "stale",
  }),
  S: Object.freeze({
    P: "stale",
    R: "running",
    B: "stale",
    F: "stale",
    C: "stale",
    S: "stale",
  }),
});

function generationStep(code, stepName) {
  const state = stateByCode[code];
  const committed = ["C", "S"].includes(code);
  return {
    state,
    revision: committed ? 1 : 0,
    artifacts: [],
    finished_at: committed ? `2026-07-23T12:0${stepName.length}:00.000Z` : null,
    error: code === "F" ? { retryable: true } : null,
    blocker: code === "B" ? { retryable: true } : null,
  };
}

function healthStep(name, step) {
  return {
    name,
    state: step.state,
    artifact_health: step.revision > 0 ? "current" : "not_published",
    input_health: step.revision > 0 ? "current" : "not_published",
    issues: [],
  };
}

function lifecycleFixture(cvCode = "P", letterCode = "P") {
  const log = createValidV3Log();
  const process = log.processes.find((record) => record.artifact_mode === "file-backed");
  process.steps.generate_cv = generationStep(cvCode, "generate_cv");
  process.steps.write_cover_letter = generationStep(letterCode, "write_cover_letter");
  const health = {
    process_id: process.id,
    mode: "file-backed",
    health: "current",
    output: {
      health: "current",
      code: null,
    },
    steps: Object.entries(process.steps).map(([name, step]) => healthStep(name, step)),
  };
  return { health, process };
}

function completedCvStep(process) {
  const inputs = structuredClone(process.steps.map_experience.artifacts);
  const artifacts = [
    {
      kind: "cv_source",
      path: "cv.json",
      schema_version: null,
      sha256: "8".repeat(64),
      bytes: 5_555,
    },
    {
      kind: "cv_docx",
      path: "Candidate_Name_Public_DTO.docx",
      schema_version: null,
      sha256: "9".repeat(64),
      bytes: 44_444,
    },
  ];
  return {
    state: "completed",
    attempt: 1,
    revision: 1,
    started_at: "2026-07-23T11:30:00.000Z",
    updated_at: "2026-07-23T11:40:00.000Z",
    finished_at: "2026-07-23T11:40:00.000Z",
    published_inputs: inputs,
    artifacts,
    active_attempt: null,
    publication_transaction: null,
    attempt_history: [
      {
        attempt: 1,
        outcome: "completed",
        started_at: "2026-07-23T11:30:00.000Z",
        finished_at: "2026-07-23T11:40:00.000Z",
        input_snapshot: structuredClone(inputs),
        error_code: null,
        publication_id: "publication_public_dto_cv",
      },
    ],
    error: null,
    blocker: null,
  };
}

function publicDtoFixture() {
  const log = createValidV3Log();
  const process = log.processes.find((record) => record.artifact_mode === "file-backed");
  process.steps.generate_cv = completedCvStep(process);
  const report = {
    schema_version: 4,
    health: "current",
    processes: log.processes.map((record) => {
      if (record.artifact_mode !== "file-backed") {
        return {
          process_id: record.id,
          mode: "historical",
          health: "historical",
          output: { health: "not_evaluated", code: null },
          steps: [],
        };
      }
      return {
        process_id: record.id,
        mode: "file-backed",
        health: "current",
        output: { health: "current", code: null },
        steps: Object.entries(record.steps).map(([name, step]) => healthStep(name, step)),
      };
    }),
  };
  return { log, process, report };
}

test("derived lifecycle implements the complete generation-sibling truth table", () => {
  for (const cvCode of Object.keys(stateByCode)) {
    for (const letterCode of Object.keys(stateByCode)) {
      const fixture = lifecycleFixture(cvCode, letterCode);
      const lifecycle = derivePublicLifecycle(fixture.process, fixture.health);
      assert.equal(
        lifecycle.state,
        expectedSiblingAggregate[cvCode][letterCode],
        `${cvCode}/${letterCode}`,
      );
    }
  }
});

test("artifact health takes precedence over lifecycle completion", () => {
  const corrupt = lifecycleFixture("C", "C");
  const corruptStep = corrupt.health.steps.find((step) => step.name === "generate_cv");
  corruptStep.artifact_health = "corrupt";
  corruptStep.issues = ["artifact_corrupt"];
  const corruptLifecycle = derivePublicLifecycle(corrupt.process, corrupt.health);
  assert.equal(corruptLifecycle.state, "corrupt");
  assert.equal(corruptLifecycle.has_corrupt, true);
  assert.ok(corruptLifecycle.attention_steps.includes("generate_cv"));

  const missing = lifecycleFixture("C", "C");
  const missingStep = missing.health.steps.find((step) => step.name === "write_cover_letter");
  missingStep.artifact_health = "missing";
  missingStep.issues = ["artifact_missing"];
  const missingLifecycle = derivePublicLifecycle(missing.process, missing.health);
  assert.equal(missingLifecycle.state, "missing");
  assert.equal(missingLifecycle.has_missing, true);
  assert.notEqual(missingLifecycle.state, "complete");
});

test("both generation siblings are actionable after a current Step 3", () => {
  const fixture = lifecycleFixture("P", "P");
  const lifecycle = derivePublicLifecycle(fixture.process, fixture.health);
  assert.deepEqual(lifecycle.actionable_steps, ["generate_cv", "write_cover_letter"]);

  const failedCv = lifecycleFixture("F", "P");
  const failedLifecycle = derivePublicLifecycle(failedCv.process, failedCv.health);
  assert.deepEqual(failedLifecycle.actionable_steps, ["generate_cv", "write_cover_letter"]);
  assert.ok(failedLifecycle.attention_steps.includes("generate_cv"));
});

test("dynamic committed-input unavailability cannot derive complete", () => {
  const fixture = lifecycleFixture("C", "C");
  const mapHealth = fixture.health.steps.find((step) => step.name === "map_experience");
  mapHealth.input_health = "unavailable";
  mapHealth.issues = ["input_invalid"];
  const lifecycle = derivePublicLifecycle(fixture.process, fixture.health);
  assert.notEqual(lifecycle.state, "complete");
  assert.ok(lifecycle.attention_steps.includes("map_experience"));
});

test("has_cv requires a healthy committed source and DOCX pair", () => {
  const fixture = lifecycleFixture("C", "C");
  fixture.process.steps.generate_cv.artifacts = [
    {
      kind: "cv_source",
      path: "cv.json",
      schema_version: null,
      sha256: "1".repeat(64),
      bytes: 10,
    },
    {
      kind: "cv_docx",
      path: "Candidate_Name_Test.docx",
      schema_version: null,
      sha256: "2".repeat(64),
      bytes: 20,
    },
  ];
  assert.equal(derivePublicLifecycle(fixture.process, fixture.health).has_cv, true);
  fixture.health.steps.find((step) => step.name === "generate_cv").artifact_health = "corrupt";
  assert.equal(derivePublicLifecycle(fixture.process, fixture.health).has_cv, false);
});

test("manual review is derived from current publication, never historical or mutable state", () => {
  const fixture = lifecycleFixture("P", "P");
  assert.equal(derivePublicLifecycle(fixture.process, fixture.health).manual_review_required, true);

  for (const step of Object.values(fixture.process.steps)) {
    step.state = "pending";
    step.revision = 0;
    step.artifacts = [];
  }
  fixture.health.steps = Object.entries(fixture.process.steps).map(([name, step]) =>
    healthStep(name, step),
  );
  assert.equal(
    derivePublicLifecycle(fixture.process, fixture.health).manual_review_required,
    false,
  );
});

test("public DTOs expose only derived review state and the detail DOCX-path exception", () => {
  const fixture = publicDtoFixture();
  const list = buildPublicProcessList({
    log: fixture.log,
    report: fixture.report,
    query: "",
  });
  const listProcess = list.results.find((result) => result.process.id === fixture.process.id);
  const historicalProcess = list.results.find((result) => result.process.mode === "historical");
  assert.equal(listProcess.process.has_cv, true);
  assert.equal(listProcess.process.manual_review_required, true);
  assert.equal(historicalProcess.process.manual_review_required, false);
  assert.deepEqual(
    Object.keys(listProcess.process).sort(),
    [
      "actionable_steps",
      "attention_steps",
      "company_hint",
      "company_observed",
      "completed_steps",
      "has_corrupt",
      "has_cv",
      "has_missing",
      "has_stale",
      "id",
      "last_completed_step",
      "lifecycle_state",
      "manual_review_required",
      "mode",
      "readable_artifact_count",
      "role",
      "running_steps",
      "source_ref",
      "started_at",
      "updated_at",
    ].sort(),
  );
  const listText = JSON.stringify(listProcess);
  assert.doesNotMatch(listText, /cv\.json|Candidate_Name_Public_DTO/);
  assert.doesNotMatch(listText, /8{64}|9{64}/);

  const detail = buildPublicProcessDetail({
    log: fixture.log,
    processId: fixture.process.id,
    report: fixture.report,
  });
  assert.deepEqual(detail.cv, {
    status: "published",
    preview_available: false,
    docx_path: "output/example-labs-senior-sdet/Candidate_Name_Public_DTO.docx",
  });
  const detailText = JSON.stringify(detail);
  assert.doesNotMatch(detailText, /cv\.json|8{64}|9{64}/);
  assert.doesNotMatch(detailText, /ready_to_send|review_receipt|human_approved/);
  assert.deepEqual(
    Object.keys(detail.lifecycle).sort(),
    [
      "actionable_steps",
      "attention_steps",
      "completed_steps",
      "has_corrupt",
      "has_cv",
      "has_missing",
      "has_stale",
      "last_completed_step",
      "manual_review_required",
      "readable_artifact_count",
      "running_steps",
      "state",
    ].sort(),
  );
  assert.equal(
    detail.artifacts.some((artifact) => ["cv_source", "cv_docx"].includes(artifact.kind)),
    false,
  );
});

test("prepared publication journals and staging names never enter public DTOs", () => {
  const fixture = publicDtoFixture();
  fixture.process.steps.generate_cv = createRunningPublicationStep();
  const processHealth = fixture.report.processes.find(
    (process) => process.process_id === fixture.process.id,
  );
  const generationHealth = processHealth.steps.find((step) => step.name === "generate_cv");
  generationHealth.state = "running";
  generationHealth.artifact_health = "recovery_required";
  generationHealth.input_health = "not_published";
  generationHealth.issues = ["publication_recovery_required"];

  const list = buildPublicProcessList({
    log: fixture.log,
    report: fixture.report,
    query: "",
  });
  const detail = buildPublicProcessDetail({
    log: fixture.log,
    processId: fixture.process.id,
    report: fixture.report,
  });
  const serialized = JSON.stringify({ list, detail });
  assert.doesNotMatch(serialized, /\.pipeline-tmp|publication_generate_cv_001/);
  assert.doesNotMatch(serialized, /candidate_path|backup_path|new_artifacts/);
  assert.equal(detail.lifecycle.state, "corrupt");
  assert.equal(detail.lifecycle.manual_review_required, true);
  assert.notEqual(detail.cv?.status, "ready");
  assert.ok(
    detail.steps
      .find((step) => step.name === "generate_cv")
      .issues.includes("publication_recovery_required"),
  );
});
