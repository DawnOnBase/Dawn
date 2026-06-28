// Package wsserver exposes the coordinator over the shared WebSocket protocol
// . It is a thin adapter: read frame → decode →
// coordinator.Handle → write reply. Per-connection Session state lives here.
package wsserver

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"github.com/DawnOnBase/Dawn/services/job-queue/internal/coordinator"
	"github.com/DawnOnBase/Dawn/services/job-queue/internal/protocol"
)

type Server struct {
	coord *coordinator.Coordinator
}

func New(c *coordinator.Coordinator) *Server { return &Server{coord: c} }

// Handler returns the HTTP mux: /agent (WebSocket) + /healthz.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/agent", s.handleAgent)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	return mux
}

func (s *Server) handleAgent(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()

	ctx := r.Context()
	session := &coordinator.Session{}
	// On disconnect, release any in-flight job back to the queue. The request ctx is
	// cancelled by the close, so use a fresh short-lived ctx for the cleanup write.
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		s.coord.Disconnect(cleanupCtx, session)
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return // client closed or read error
		}
		msg, err := protocol.DecodeAgentMessage(data)
		if err != nil {
			conn.Close(websocket.StatusUnsupportedData, truncateReason(err))
			return
		}
		reply, err := s.coord.Handle(ctx, session, msg)
		if err != nil {
			code := websocket.StatusInternalError
			if errors.Is(err, coordinator.ErrUnauthenticated) {
				code = websocket.StatusPolicyViolation
			}
			conn.Close(code, truncateReason(err))
			return
		}
		if reply == nil {
			continue
		}
		b, err := reply.Encode()
		if err != nil {
			conn.Close(websocket.StatusInternalError, "encode error")
			return
		}
		if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
			return
		}
	}
}

// truncateReason keeps WebSocket close reasons within the 123-byte limit.
func truncateReason(err error) string {
	s := err.Error()
	if len(s) > 120 {
		return s[:120]
	}
	return s
}
