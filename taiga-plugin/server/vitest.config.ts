import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // test/integration/** shares one live Taiga stand (infra/README.md) and
    // some files manage the same setup/teardown state on it for the
    // duration of their own describe block — e.g. both resources.test.ts's
    // "оценка и роль задачи" and search-bulk.test.ts's "bulk create: оценка
    // и роль задач" create (and one of them deletes/recreates) the task
    // custom field named «Оценка» on the same project. Running test files
    // in parallel workers lets those windows overlap and race (one file's
    // beforeAll fails with "already exists", or a mid-test delete in one
    // file yanks the field out from under another file's concurrently
    // running assertions). Sequential files trade some wall-clock time for
    // a suite that does not depend on how fast any one call happens to be.
    fileParallelism: false,
  },
});
