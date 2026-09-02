// Tetris Engine — Go Reference Implementation
// WebSocket server with unified protocol contract for polyglot state handoff.
// Single HTTP port (default 8000) serving /ws, /health, /metrics.
package main

import (
	"log"
	"os"

	wsserver "tetris-polyglot/go-engine/internal/wsserver"
)

func main() {
	port := os.Getenv("HTTP_PORT")
	if port == "" {
		port = "8000"
	}

	log.Printf("Starting Go Tetris Engine (pid: %d)", os.Getpid())
	log.Printf("Listening on HTTP/WS :%s", port)

	server := wsserver.New(":"+port, 100)
	server.Run()
}
