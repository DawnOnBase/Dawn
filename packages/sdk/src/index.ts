export { DawnClient } from "./client.ts";
export * from "./errors.ts";
export * from "./types.ts";

// Re-export the cross-cutting shapes so SDK consumers don't also need to depend
// on @dawn/shared directly.
export { JobStatus } from "@dawn/shared";
export type { Address, Hex, Job, JobRequirements, JobType, NodeProfile, ProofBundle } from "@dawn/shared";
