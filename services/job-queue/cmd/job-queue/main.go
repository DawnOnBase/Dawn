// Command job-queue runs the Dawn matching coordinator .
// It serves the agent WebSocket protocol and sweeps timed-out jobs. Postgres is
// used when DATABASE_URL is set; otherwise an in-memory queue runs (dev only).
package main

import (
	"context"
	"encoding/hex"
	"log"
	"math/big"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/coordinator"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/dispatch"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/matching"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/orchestrator"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/presence"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/queue"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/store/postgres"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/wsserver"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	addr := ":" + env("PORT", "8090")
	dsn := os.Getenv("DATABASE_URL")
	now := func() int64 { return time.Now().Unix() }
	weights := matching.Weights{}

	var (
		q       queue.Queue
		inputs  coordinator.InputResolver
		pgStore *postgres.Store // concrete handle for the StakeOracle (nil in dev)
		closeFn = func() {}
	)
	if dsn != "" {
		store, err := postgres.New(ctx, dsn, now, weights)
		if err != nil {
			log.Fatalf("job-queue: postgres: %v", err)
		}
		q, inputs, pgStore, closeFn = store, store, store, store.Close
		log.Printf("job-queue: using Postgres backend")
	} else {
		log.Printf("job-queue: DATABASE_URL not set — using in-memory queue (DEV ONLY)")
		q = queue.NewMemory(now, weights)
		inputs = coordinator.NewMapInputResolver()
	}
	defer closeFn()

	// Forward proofs to proof-service over HTTP when configured; otherwise
	// log them (dev only — proofs are dropped, never settled).
	var proofs coordinator.ProofSink
	if proofURL := os.Getenv("PROOF_SERVICE_URL"); proofURL != "" {
		proofs = coordinator.NewProofServiceClient(proofURL, nil)
		log.Printf("job-queue: forwarding proofs to proof-service at %s", proofURL)
	} else {
		log.Printf("job-queue: PROOF_SERVICE_URL not set — proofs logged, not settled (DEV ONLY)")
		proofs = coordinator.ProofSinkFunc(func(_ context.Context, sub coordinator.ProofSubmission) error {
			log.Printf("job-queue: proof received job=%s output=%s resultRef=%s redundancy=%d merkleProof=%d",
				sub.Proof.JobID, sub.Proof.OutputHash, sub.ResultRef, sub.Redundancy, len(sub.MerkleProof))
			return nil
		})
	}

	coord := coordinator.New(q, authenticator(), inputs, proofs, now)

	go sweepLoop(ctx, q, now)

	handler := wsserver.New(coord).Handler()

	// M9 committee dispatch: enabled when an orchestrator signing key is configured. It seats +
	// signs committees from connected operators (POST /v1/assignments) and activates them on escrow.
	if dispatchSvc := buildDispatch(ctx, q, coord, pgStore, weights, now); dispatchSvc != nil {
		root := http.NewServeMux()
		root.Handle("/", handler)
		root.Handle("/v1/assignments", dispatchSvc.Handler())
		handler = root
		go activateLoop(ctx, dispatchSvc)
	}

	srv := &http.Server{Addr: addr, Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		log.Printf("job-queue: listening on %s", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("job-queue: serve: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("job-queue: shutting down")
	shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
}

// buildDispatch wires the M9 committee dispatcher when ORCHESTRATOR_KEY is set, returning nil
// (dispatch disabled) otherwise. CHAIN_ID + SETTLEMENT_ADDRESS pin the EIP-712 domain the signature
// is valid for; the StakeOracle (Postgres only) gates committees by bond. A misconfigured key is
// fatal — running with redundancy "enabled" but a broken signer would silently never seat anyone.
func buildDispatch(
	ctx context.Context, q queue.Queue, coord *coordinator.Coordinator, pgStore *postgres.Store,
	weights matching.Weights, now queue.Clock,
) *dispatch.Service {
	key := os.Getenv("ORCHESTRATOR_KEY")
	if key == "" {
		log.Printf("job-queue: ORCHESTRATOR_KEY not set — M9 committee dispatch disabled")
		return nil
	}
	chainID, ok := new(big.Int).SetString(env("CHAIN_ID", "84532"), 10)
	if !ok {
		log.Fatalf("job-queue: invalid CHAIN_ID")
	}
	settlement := os.Getenv("SETTLEMENT_ADDRESS")
	if settlement == "" {
		log.Fatalf("job-queue: SETTLEMENT_ADDRESS required when ORCHESTRATOR_KEY is set")
	}
	keyBytes, err := hex.DecodeString(strings.TrimPrefix(key, "0x"))
	if err != nil {
		log.Fatalf("job-queue: ORCHESTRATOR_KEY not hex: %v", err)
	}
	signer, err := orchestrator.NewSigner(secp256k1.PrivKeyFromBytes(keyBytes), chainID, settlement)
	if err != nil {
		log.Fatalf("job-queue: orchestrator signer: %v", err)
	}

	registry := presence.NewRegistry()
	coord.WithPresence(registry)

	var stake matching.StakeOracle
	if pgStore != nil {
		oracle := pgStore.StakeOracle()
		go oracle.Run(ctx, 30*time.Second, func(err error) { log.Printf("job-queue: stake oracle refresh: %v", err) })
		stake = oracle
		log.Printf("job-queue: committee stake pre-filter enabled (operator_stakes)")
	}

	log.Printf("job-queue: M9 committee dispatch enabled (orchestrator %s, chain %s)", signer.Address(), chainID)
	return dispatch.New(q, signer, registry, stake, weights, now)
}

// activateLoop promotes signed committees to active once their job is escrowed, every 10s.
func activateLoop(ctx context.Context, svc *dispatch.Service) {
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if n, err := svc.ActivatePending(ctx); err != nil {
				log.Printf("job-queue: committee activation: %v", err)
			} else if n > 0 {
				log.Printf("job-queue: activated %d redundant committee(s)", n)
			}
		}
	}
}

// sweepLoop marks timed-out jobs every 30s until ctx is cancelled.
func sweepLoop(ctx context.Context, q queue.Queue, now queue.Clock) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			n, err := q.SweepTimeouts(ctx, now())
			if err != nil {
				log.Printf("job-queue: sweep error: %v", err)
			} else if n > 0 {
				log.Printf("job-queue: swept %d timed-out jobs", n)
			}
		}
	}
}

// authenticator selects the node-auth scheme. The default is real EIP-191
// HELLO_AUTH recovery; AUTH_ALLOW_ALL=1 opts into the insecure dev stub
// that accepts any non-empty nodeId (local testing only, never in production).
func authenticator() coordinator.Authenticator {
	if os.Getenv("AUTH_ALLOW_ALL") == "1" {
		log.Printf("job-queue: AUTH_ALLOW_ALL=1 — node signatures NOT verified (DEV ONLY)")
		return coordinator.AllowAllAuth{}
	}
	return coordinator.EIP191Auth{}
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
