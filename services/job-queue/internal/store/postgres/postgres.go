// Package postgres is the production Queue implementation
// backed by Postgres. The claim hot path uses FOR UPDATE SKIP LOCKED so many
// coordinator workers can pull jobs concurrently without contention.
//
// It implements queue.Queue identically to the in-memory store and reuses the
// same matching + statemachine logic, so behavior is consistent across both.
package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/domain"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/matching"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/queue"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/statemachine"
)

// Store implements queue.Queue against Postgres.
type Store struct {
	pool    *pgxpool.Pool
	now     queue.Clock
	weights matching.Weights
	// claimBatch is how many eligible rows are locked per claim before scoring.
	claimBatch int
}

// New opens a pool to dsn and returns a Store.
func New(ctx context.Context, dsn string, now queue.Clock, w matching.Weights) (*Store, error) {
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		return nil, fmt.Errorf("postgres: connect: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("postgres: ping: %w", err)
	}
	if now == nil {
		now = func() int64 { return 0 }
	}
	return &Store{pool: pool, now: now, weights: w, claimBatch: 32}, nil
}

func (s *Store) Close() { s.pool.Close() }

const jobCols = `job_id, buyer, job_type, amount_usdc, deadline, status, operator, input_ref,
	min_gpu_tier, min_vram_gb, min_cpu_cores, min_ram_gb, estimated_duration_sec, redundancy,
	input_hash, operators, operator_set_root, assignment_sig, nonce, bond`

// row is the scan target; nullable columns use pointers.
type row struct {
	jobID, buyer, jobType, amount string
	deadline                      int64
	status                        string
	operator, inputRef            *string
	minGpuTier, minVramGb         *int
	minCpuCores, minRamGb         *int
	estDuration                   int
	redundancy                    *int
	// M9 redundant-execution columns (all nullable; absent for single-node rows).
	inputHash, operatorSetRoot *string
	operators                  []string
	assignmentSig, bond        *string
	nonce                      *int64
}

func scan(r pgx.Row) (domain.Job, string, error) {
	var x row
	err := r.Scan(&x.jobID, &x.buyer, &x.jobType, &x.amount, &x.deadline, &x.status,
		&x.operator, &x.inputRef, &x.minGpuTier, &x.minVramGb, &x.minCpuCores, &x.minRamGb,
		&x.estDuration, &x.redundancy,
		&x.inputHash, &x.operators, &x.operatorSetRoot, &x.assignmentSig, &x.nonce, &x.bond)
	if err != nil {
		return domain.Job{}, "", err
	}
	j := domain.Job{
		JobID: x.jobID, Buyer: x.buyer, AmountUsdc: x.amount, Deadline: x.deadline,
		Status:   domain.JobStatus(x.status),
		Operator: x.operator,
		Requirements: domain.JobRequirements{
			JobType: domain.JobType(x.jobType), MinGpuTier: x.minGpuTier, MinVramGb: x.minVramGb,
			MinCpuCores: x.minCpuCores, MinRamGb: x.minRamGb,
			EstimatedDurationSec: x.estDuration, Redundancy: x.redundancy,
		},
		Operators: x.operators,
	}
	j.InputHash = deref(x.inputHash)
	j.OperatorSetRoot = deref(x.operatorSetRoot)
	j.AssignmentSig = deref(x.assignmentSig)
	j.Bond = deref(x.bond)
	if x.nonce != nil {
		j.Nonce = uint64(*x.nonce)
	}
	ref := ""
	if x.inputRef != nil {
		ref = *x.inputRef
	}
	return j, ref, nil
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func (s *Store) Enqueue(ctx context.Context, j domain.Job) error {
	if j.Status != domain.StatusSubmitted && j.Status != domain.StatusEscrowed {
		return queue.ErrConflict
	}
	req := j.Requirements
	_, err := s.pool.Exec(ctx, `
		INSERT INTO jobs (job_id, buyer, job_type, amount_usdc, deadline, status, operator,
			min_gpu_tier, min_vram_gb, min_cpu_cores, min_ram_gb, estimated_duration_sec, redundancy)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		j.JobID, j.Buyer, string(req.JobType), j.AmountUsdc, j.Deadline, string(j.Status), j.Operator,
		req.MinGpuTier, req.MinVramGb, req.MinCpuCores, req.MinRamGb, req.EstimatedDurationSec, req.Redundancy)
	if err != nil {
		// 23505 = unique_violation (duplicate job_id)
		var pgErr interface{ SQLState() string }
		if errors.As(err, &pgErr) && pgErr.SQLState() == "23505" {
			return queue.ErrConflict
		}
		return err
	}
	return nil
}

func (s *Store) Get(ctx context.Context, jobID domain.Hex) (domain.Job, error) {
	r := s.pool.QueryRow(ctx, `SELECT `+jobCols+` FROM jobs WHERE job_id = $1`, jobID)
	j, _, err := scan(r)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Job{}, queue.ErrNotFound
	}
	return j, err
}

// Claim locks up to claimBatch eligible escrowed rows (SKIP LOCKED), scores them
// with the matching engine, and assigns the best to the node in one tx.
func (s *Store) Claim(ctx context.Context, node domain.NodeProfile) (domain.Job, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Job{}, err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx, `
		SELECT `+jobCols+` FROM jobs
		WHERE status = 'escrowed'
		  AND (min_cpu_cores IS NULL OR min_cpu_cores <= $1)
		  AND (min_ram_gb   IS NULL OR min_ram_gb   <= $2)
		  AND (min_gpu_tier  IS NULL OR min_gpu_tier <= $3)
		  AND (min_vram_gb   IS NULL OR min_vram_gb  <= $4)
		ORDER BY deadline ASC
		FOR UPDATE SKIP LOCKED
		LIMIT $5`,
		node.CpuCores, node.RamGb, valOrNeg(node.GpuTier), valOrNeg(node.VramGb), s.claimBatch)
	if err != nil {
		return domain.Job{}, err
	}

	var candidates []domain.Job
	for rows.Next() {
		j, _, err := scan(rows)
		if err != nil {
			rows.Close()
			return domain.Job{}, err
		}
		candidates = append(candidates, j)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return domain.Job{}, err
	}

	best := matching.BestJobForNode(node, candidates, s.now(), s.weights)
	if best == nil {
		return domain.Job{}, queue.ErrNoJob
	}
	next, err := statemachine.Transition(best.Status, domain.StatusMatched)
	if err != nil {
		return domain.Job{}, queue.ErrConflict
	}
	if _, err := tx.Exec(ctx,
		`UPDATE jobs SET status=$1, operator=$2, updated_at=now() WHERE job_id=$3`,
		string(next), node.NodeID, best.JobID); err != nil {
		return domain.Job{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Job{}, err
	}
	best.Status = next
	op := node.NodeID
	best.Operator = &op
	return *best, nil
}

func (s *Store) Transition(ctx context.Context, jobID domain.Hex, to domain.JobStatus) (domain.Job, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Job{}, err
	}
	defer tx.Rollback(ctx)

	r := tx.QueryRow(ctx, `SELECT `+jobCols+` FROM jobs WHERE job_id=$1 FOR UPDATE`, jobID)
	j, _, err := scan(r)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Job{}, queue.ErrNotFound
	}
	if err != nil {
		return domain.Job{}, err
	}
	next, err := statemachine.Transition(j.Status, to)
	if err != nil {
		return domain.Job{}, queue.ErrConflict
	}
	if _, err := tx.Exec(ctx, `UPDATE jobs SET status=$1, updated_at=now() WHERE job_id=$2`, string(next), jobID); err != nil {
		return domain.Job{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Job{}, err
	}
	j.Status = next
	return j, nil
}

func (s *Store) RecordResult(ctx context.Context, jobID domain.Hex, resultRef, outputHash string) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE jobs SET result_ref=$1, output_hash=$2, updated_at=now() WHERE job_id=$3`,
		resultRef, outputHash, jobID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return queue.ErrNotFound
	}
	return nil
}

func (s *Store) Requeue(ctx context.Context, jobID domain.Hex) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	r := tx.QueryRow(ctx, `SELECT `+jobCols+` FROM jobs WHERE job_id=$1 FOR UPDATE`, jobID)
	j, _, err := scan(r)
	if errors.Is(err, pgx.ErrNoRows) {
		return queue.ErrNotFound
	}
	if err != nil {
		return err
	}
	if _, err := statemachine.Transition(j.Status, domain.StatusEscrowed); err != nil {
		return queue.ErrConflict
	}
	if _, err := tx.Exec(ctx,
		`UPDATE jobs SET status='escrowed', operator=NULL, updated_at=now() WHERE job_id=$1`, jobID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) SweepTimeouts(ctx context.Context, now int64) (int, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE jobs SET status='timed_out', updated_at=now()
		WHERE deadline < $1
		  AND status IN ('submitted','escrowed','matched','running')`, now)
	if err != nil {
		return 0, err
	}
	return int(tag.RowsAffected()), nil
}

func (s *Store) List(ctx context.Context, status domain.JobStatus) ([]domain.Job, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+jobCols+` FROM jobs WHERE status=$1`, string(status))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.Job
	for rows.Next() {
		j, _, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// InputRef resolves the off-chain input ref column (implements
// coordinator.InputResolver) so the Postgres store doubles as the resolver.
func (s *Store) InputRef(ctx context.Context, jobID domain.Hex) (string, error) {
	var ref *string
	err := s.pool.QueryRow(ctx, `SELECT input_ref FROM jobs WHERE job_id=$1`, jobID).Scan(&ref)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", queue.ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if ref == nil {
		return "", fmt.Errorf("postgres: job %s has no input_ref", jobID)
	}
	return *ref, nil
}

// AssignCommittee records the orchestrator-signed Assignment on an escrowed redundant job and
// transitions it Escrowed → Matched in one tx, guarded by the current status so two dispatchers
// cannot double-assign. Mirrors Memory.AssignCommittee.
func (s *Store) AssignCommittee(ctx context.Context, jobID domain.Hex, a queue.CommitteeAssignment) (domain.Job, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Job{}, err
	}
	defer tx.Rollback(ctx)

	r := tx.QueryRow(ctx, `SELECT `+jobCols+` FROM jobs WHERE job_id=$1 FOR UPDATE`, jobID)
	j, _, err := scan(r)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Job{}, queue.ErrNotFound
	}
	if err != nil {
		return domain.Job{}, err
	}
	if !j.IsRedundant() || j.Status != domain.StatusEscrowed || len(a.Operators) == 0 {
		return domain.Job{}, queue.ErrConflict
	}
	next, err := statemachine.Transition(j.Status, domain.StatusMatched)
	if err != nil {
		return domain.Job{}, queue.ErrConflict
	}
	if _, err := tx.Exec(ctx, `
		UPDATE jobs SET status=$1, operators=$2, operator_set_root=$3, input_hash=$4,
			assignment_sig=$5, nonce=$6, bond=$7, updated_at=now()
		WHERE job_id=$8`,
		string(next), a.Operators, a.OperatorSetRoot, a.InputHash,
		a.AssignmentSig, int64(a.Nonce), a.Bond, jobID); err != nil {
		return domain.Job{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Job{}, err
	}
	j.Status = next
	j.Operators = append([]domain.Address(nil), a.Operators...)
	j.OperatorSetRoot = a.OperatorSetRoot
	j.InputHash = a.InputHash
	j.AssignmentSig = a.AssignmentSig
	j.Nonce = a.Nonce
	j.Bond = a.Bond
	return j, nil
}

// FindCommitteeJob returns a Matched/Running redundant job for which nodeID is an authorized member
// that has not yet submitted (LEFT JOIN anti-match on committee_submissions). Read-only — all M
// members can pull the same job concurrently.
func (s *Store) FindCommitteeJob(ctx context.Context, nodeID domain.Address) (domain.Job, error) {
	r := s.pool.QueryRow(ctx, `
		SELECT `+jobCols+` FROM jobs j
		WHERE j.status IN ('matched','running')
		  AND j.operators @> ARRAY[$1::text]
		  AND NOT EXISTS (
		      SELECT 1 FROM committee_submissions cs
		      WHERE cs.job_id = j.job_id AND cs.operator = $1)
		ORDER BY j.deadline ASC
		LIMIT 1`, nodeID)
	j, _, err := scan(r)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Job{}, queue.ErrNoJob
	}
	if err != nil {
		return domain.Job{}, err
	}
	return j, nil
}

// RecordCommitteeSubmission inserts the (job, operator) slot and returns the distinct submission
// count. A duplicate insert (operator already submitted) is a 23505 unique-violation → ErrConflict;
// a non-member operator is rejected before the insert.
func (s *Store) RecordCommitteeSubmission(ctx context.Context, jobID domain.Hex, operator domain.Address) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)

	r := tx.QueryRow(ctx, `SELECT `+jobCols+` FROM jobs WHERE job_id=$1 FOR UPDATE`, jobID)
	j, _, err := scan(r)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, queue.ErrNotFound
	}
	if err != nil {
		return 0, err
	}
	if !j.InCommittee(operator) {
		return 0, queue.ErrConflict
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO committee_submissions (job_id, operator) VALUES ($1,$2)`, jobID, operator); err != nil {
		var pgErr interface{ SQLState() string }
		if errors.As(err, &pgErr) && pgErr.SQLState() == "23505" {
			return 0, queue.ErrConflict // one slot per operator
		}
		return 0, err
	}
	var count int
	if err := tx.QueryRow(ctx,
		`SELECT count(*) FROM committee_submissions WHERE job_id=$1`, jobID).Scan(&count); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return count, nil
}

// valOrNeg maps a nil capability to -1 so the SQL `min <= cap` filter excludes
// jobs that require a capability the node lacks (e.g. CPU-only node, GPU job).
func valOrNeg(p *int) int {
	if p == nil {
		return -1
	}
	return *p
}

var _ queue.Queue = (*Store)(nil)
