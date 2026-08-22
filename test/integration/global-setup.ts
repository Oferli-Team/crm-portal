import { startTestDatabase, stopTestDatabase } from "../support/local-postgres";

// Runs once in Vitest's main process before any integration test file
// loads, regardless of how many worker threads/processes run the actual
// tests — they all reach this same instance over its real TCP socket
// (see test/support/local-postgres.ts).
export async function setup(): Promise<void> {
  await startTestDatabase();
}

export async function teardown(): Promise<void> {
  await stopTestDatabase();
}
