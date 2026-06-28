// Command migrate applies the SQL migrations in lexical order against
// DATABASE_URL. Files are idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
// so it is safe to re-run. No secrets here — the DSN comes from the environment.
//
//	DATABASE_URL=postgres://… go run ./cmd/migrate
package main

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"sort"

	"github.com/jackc/pgx/v5"
)

func main() {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("migrate: DATABASE_URL is not set")
	}
	dir := os.Getenv("MIGRATIONS_DIR")
	if dir == "" {
		dir = "migrations"
	}

	ctx := context.Background()
	conn, err := pgx.Connect(ctx, dsn)
	if err != nil {
		log.Fatalf("migrate: connect: %v", err)
	}
	defer conn.Close(ctx)

	files, err := filepath.Glob(filepath.Join(dir, "*.sql"))
	if err != nil {
		log.Fatalf("migrate: glob %s: %v", dir, err)
	}
	if len(files) == 0 {
		log.Fatalf("migrate: no .sql files in %s", dir)
	}
	sort.Strings(files)

	for _, f := range files {
		stmts, err := os.ReadFile(f)
		if err != nil {
			log.Fatalf("migrate: read %s: %v", f, err)
		}
		// Simple protocol so multi-statement files run as one batch.
		if _, err := conn.PgConn().Exec(ctx, string(stmts)).ReadAll(); err != nil {
			log.Fatalf("migrate: apply %s: %v", filepath.Base(f), err)
		}
		log.Printf("migrate: applied %s", filepath.Base(f))
	}

	// Report the resulting public tables for confirmation.
	rows, err := conn.Query(ctx,
		`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`)
	if err != nil {
		log.Fatalf("migrate: list tables: %v", err)
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			log.Fatalf("migrate: scan: %v", err)
		}
		tables = append(tables, name)
	}
	log.Printf("migrate: done (%d files). public tables: %v", len(files), tables)
}
