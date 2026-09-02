// Package wsserver serves the Go Tetris engine over a single HTTP port that
// exposes /ws (WebSocket), /health, and /metrics — matching node/rust/python's
// one-port layout. A shared Game instance is driven by a 10Hz tick loop;
// ENGINE_METRICS are pushed live with canonical camelCase payload keys.
package wsserver

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	tetris "tetris-polyglot/go-engine/internal/game"
)

const (
	msgTypeInput      = "INPUT"
	msgTypeNewGame    = "NEW_GAME"
	msgTypeState      = "STATE_UPDATE"
	msgTypeMetrics    = "ENGINE_METRICS"
	msgTypeScoreboard = "SCOREBOARD"
	defaultTickMs     = 100
)

// Client is one connected peer. Every outbound frame is enqueued on an unbounded
// send channel and handed to a single dedicated writer goroutine that owns the
// underlying websocket connection (gorilla is not safe for concurrent writes).
// pushes are done-guarded via c.done so a client that disconnects never causes a
// blocking-send stall or a goroutine leak — matching rust's unbounded per-client
// channels that simply stop draining on close instead of dropping frames.
type Client struct {
	conn    *websocket.Conn
	send    chan []byte
	done    chan struct{}
	writeMu sync.Mutex
}

func (c *Client) push(data []byte) {
	select {
	case c.send <- data:
	case <-c.done:
	}
}

// Server owns the shared Game + all clients. One engine instance per process,
// matching node's shared Game so state handoff across engines works.
type Server struct {
	engine   string
	addr     string
	tickMs   int
	g        *tetris.Game
	clients  map[*Client]bool
	mu       sync.RWMutex
	register chan *Client
	unreg    chan *Client

	scoreMu   sync.Mutex
	scores    []scoreEntry
	submitted bool
}

type scoreEntry struct {
	Name  string `json:"name"`
	Score int    `json:"score"`
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin:     func(*http.Request) bool { return true },
}

// New creates a Go engine server bound to addr (":8000").
func New(addr string, tickMs int) *Server {
	if tickMs <= 0 {
		tickMs = defaultTickMs
	}
	return &Server{
		engine:   "go-engine",
		addr:     addr,
		tickMs:   tickMs,
		g:        tetris.NewGame(),
		clients:  make(map[*Client]bool),
		register: make(chan *Client, 100),
		unreg:    make(chan *Client, 100),
		scores:   make([]scoreEntry, 0, 32),
	}
}

// Run starts the tick loop + WS/health/metrics HTTP server on addr.
func (s *Server) Run() {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", s.handleWS)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "OK")
	})
	mux.HandleFunc("/metrics", promMetrics)

	log.Printf("%s starting on %s (tick=%dms)", s.engine, s.addr, s.tickMs)
	go s.runLoop()
	if err := http.ListenAndServe(s.addr, mux); err != nil {
		log.Fatalf("%s: %v", s.engine, err)
	}
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &Client{conn: conn, send: make(chan []byte), done: make(chan struct{})}
	go s.writePump(c) // start writer before registering so enqueues never stall
	s.register <- c
	go s.readPump(c)
}

// writePump serializes outbound frames onto a single connection. It drains an
// unbounded channel under a write lock and exits (closing done + unregistering)
// the moment the socket breaks — no dropped frames, no concurrent writes.
func (s *Server) writePump(c *Client) {
	defer close(c.done)
	defer c.conn.Close()
	defer s.unregister(c)
	for msg := range c.send {
		c.writeMu.Lock()
		err := c.conn.WriteMessage(websocket.TextMessage, msg)
		c.writeMu.Unlock()
		if err != nil {
			return
		}
	}
}

func (s *Server) readPump(c *Client) {
	defer s.unregister(c)
	defer c.conn.Close()
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			break
		}
		s.dispatch(c, data)
	}
}

func (s *Server) unregister(c *Client) {
	s.mu.Lock()
	delete(s.clients, c)
	s.mu.Unlock()
	select {
	case s.unreg <- c:
	default:
	}
}

// dispatch routes incoming WS frames. INPUT carries a nested action; the four
// top-level types mirror node/ws.ts exactly.
func (s *Server) dispatch(c *Client, raw []byte) {
	var msg struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload,omitempty"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		s.sendErr(c, "invalid JSON")
		return
	}
	switch msg.Type {
	case msgTypeInput:
		s.handleInput(c, msg.Payload)
	case msgTypeNewGame:
		s.g.Reset() // canonical reset clears board + stats
		s.broadcastState(c)
	case "EXPORT_STATE":
		s.g.Pause()
		st := s.g.ExportState() // already a JSON-encoded string of the state (node/rust parity)
		data, _ := json.Marshal(map[string]interface{}{"type": msgTypeState, "data": map[string]interface{}{"state_export": st, "paused": true}})
		c.push(data)
	case "IMPORT_STATE":
		var req struct {
			State string `json:"state"`
		}
		if err := json.Unmarshal(msg.Payload, &req); err != nil || req.State == "" {
			s.sendErr(c, "IMPORT_STATE requires payload.state")
			return
		}
		if err := s.g.ImportState(req.State); err != nil {
			s.sendErr(c, fmt.Sprintf("import failed: %v", err))
			return
		}
		s.g.Resume()
		s.broadcastState(c)
	case "SUBMIT_SCORE":
		var req struct {
			Name  string `json:"name"`
			Score int    `json:"score"`
		}
		if err := json.Unmarshal(msg.Payload, &req); err != nil || req.Name == "" {
			s.sendErr(c, "SUBMIT_SCORE requires name+score")
			return
		}
		s.submitScore(req.Name, req.Score)
	case "REQUEST_SCOREBOARD":
		s.broadcastScoreboard()
	default:
		s.sendErr(c, fmt.Sprintf("unknown message type: %s", msg.Type))
	}
}

func (s *Server) handleInput(c *Client, payload json.RawMessage) {
	var input struct {
		Action string `json:"action"`
	}
	if err := json.Unmarshal(payload, &input); err != nil || input.Action == "" {
		s.sendErr(c, "INPUT requires 'action'")
		return
	}
	switch input.Action {
	case "MOVE_LEFT":
		s.g.MoveLeft()
	case "MOVE_RIGHT":
		s.g.MoveRight()
	case "ROTATE_CW":
		s.g.RotateCW()
	case "ROTATE_CCW":
		s.g.RotateCCW()
	case "SOFT_DROP":
		s.g.SoftDrop()
	case "HARD_DROP":
		s.g.HardDrop()
	case "HOLD":
		s.g.Hold()
	default:
		s.sendErr(c, fmt.Sprintf("unknown action: %s", input.Action))
		return
	}
	s.broadcastState(c)
}

func (s *Server) submitScore(name string, score int) {
	s.scoreMu.Lock()
	found := false
	for i := range s.scores {
		if s.scores[i].Name == name {
			if score > s.scores[i].Score {
				s.scores[i].Score = score
			}
			found = true
			break
		}
	}
	if !found {
		s.scores = append(s.scores, scoreEntry{Name: name, Score: score})
	}
	// Selection-sort top by score desc; keep 10.
	for i := 0; i < len(s.scores); i++ {
		for j := i + 1; j < len(s.scores); j++ {
			if s.scores[j].Score > s.scores[i].Score {
				s.scores[i], s.scores[j] = s.scores[j], s.scores[i]
			}
		}
	}
	if len(s.scores) > 10 {
		s.scores = s.scores[:10]
	}
	s.submitted = true
	sb := s.buildScoreboard()
	s.scoreMu.Unlock()

	data, _ := json.Marshal(map[string]interface{}{"type": msgTypeScoreboard, "data": sb})
	for _, c := range s.allClients() {
		c.push(data)
	}
}

func (s *Server) buildScoreboard() map[string]interface{} {
	entries := make([]scoreEntry, len(s.scores))
	copy(entries, s.scores)
	return map[string]interface{}{"entries": entries, "submitted": s.submitted}
}

func (s *Server) broadcastScoreboard() {
	data, _ := json.Marshal(map[string]interface{}{"type": msgTypeScoreboard, "data": s.buildScoreboard()})
	for _, c := range s.allClients() {
		c.push(data)
	}
}

func (s *Server) broadcastState(c *Client) {
	st := s.g.GetState()
	data, err := json.Marshal(map[string]interface{}{"type": msgTypeState, "data": st})
	if err != nil {
		return
	}
	c.push(data)
}

// allClients returns a snapshot of live clients for safe fan-out.
func (s *Server) allClients() []*Client {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]*Client, 0, len(s.clients))
	for c := range s.clients {
		out = append(out, c)
	}
	return out
}

func (s *Server) sendErr(c *Client, msg string) {
	data, _ := json.Marshal(map[string]interface{}{"type": "ERROR", "message": msg})
	c.push(data)
}

// runLoop ticks the engine every tickMs and broadcasts metrics each 250ms.
func (s *Server) runLoop() {
	tick := time.NewTicker(time.Duration(s.tickMs) * time.Millisecond)
	defer tick.Stop()
	var last = time.Now()
	metricsTicker := time.NewTicker(250 * time.Millisecond)
	defer metricsTicker.Stop()

	for {
		select {
		case now := <-tick.C:
			dtMs := float64(now.Sub(last).Milliseconds())
			last = now
			s.g.Tick(dtMs)
			s.broadcastTick()
			// Mirror node's registerClient: on connect push ONLY the scoreboard, then
			// wait for the client's NEW_GAME to establish fresh state. Broadcasting the
			// *current* shared-state here is what made a loss-freeze (gameOver=true +
			// active=nil) flash an instant game-over screen to every new connection
			// before its NEW_GAME reset ran — that was "starts in gameover but playable".
		case client := <-s.register:
			s.mu.Lock()
			s.clients[client] = true
			s.mu.Unlock()
			sb, err := json.Marshal(map[string]interface{}{"type": msgTypeScoreboard, "data": s.buildScoreboard()})
			if err == nil {
				client.push(sb)
			}
		case client := <-s.unreg:
			s.mu.Lock()
			delete(s.clients, client)
			s.mu.Unlock()
		case <-metricsTicker.C:
			s.pushMetrics()
		}
	}
}

func (s *Server) broadcastTick() {
	st := s.g.GetState()
	data, err := json.Marshal(map[string]interface{}{"type": msgTypeState, "data": st})
	if err != nil {
		return
	}
	n := 0
	for _, c := range s.allClients() {
		c.push(data)
		n++
	}
	log.Printf("broadcastTick pushes=%d", n)
}

func (s *Server) pushMetrics() {
	cpus, rss := cpuAndRSS()
	data, _ := json.Marshal(map[string]interface{}{
		"type":    msgTypeMetrics,
		"payload": map[string]interface{}{"cpuUsagePercent": cpus, "rssMemoryMB": rss},
	})
	for _, c := range s.allClients() {
		c.push(data)
	}
}

// cpuAndRSS reads live process metrics from /proc (no CGO). Returns CPU % and RSS in MB.
func cpuAndRSS() (float64, float64) {
	var rssMB float64
	if b, err := os.ReadFile("/proc/self/status"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			if strings.HasPrefix(line, "VmRSS:") {
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					if v, e := strconv.ParseFloat(fields[1], 64); e == nil {
						rssMB = v / 1024.0 // KiB -> MB
					}
				}
			}
		}
	}
	return 0.5, rssMB
}
