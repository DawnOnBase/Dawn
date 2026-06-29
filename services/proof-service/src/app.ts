// Fastify app for the proof-service . job-queue's coordinator
// POSTs proof submissions here for validation + redundancy consensus.

import Fastify, { type FastifyInstance } from "fastify";
import type { Hex, ProofBundle } from "@dawn/shared";
import { ProofService } from "./service.ts";

export interface AppDeps {
  service: ProofService;
}

interface SubmitProofBody {
  proof?: Partial<ProofBundle>;
  redundancy?: number;
  merkleProof?: Hex[];
}

function validProof(p: Partial<ProofBundle> | undefined): p is ProofBundle {
  return (
    !!p &&
    typeof p.jobId === "string" &&
    typeof p.inputHash === "string" &&
    typeof p.outputHash === "string" &&
    typeof p.metadata === "string" &&
    typeof p.nodeSignature === "string"
  );
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post("/v1/proofs", async (req, reply) => {
    const body = (req.body ?? {}) as SubmitProofBody;
    if (!validProof(body.proof)) return reply.code(400).send({ error: "invalid proof bundle" });
    const redundancy = typeof body.redundancy === "number" && body.redundancy > 0 ? body.redundancy : 1;
    const merkleProof = Array.isArray(body.merkleProof) ? body.merkleProof : undefined;

    const outcome = await deps.service.submit(body.proof, redundancy, merkleProof);
    if (!outcome.accepted) return reply.code(422).send({ error: outcome.reason ?? "rejected" });
    return reply.code(202).send(outcome);
  });

  return app;
}
