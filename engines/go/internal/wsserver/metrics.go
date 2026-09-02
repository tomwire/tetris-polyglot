package wsserver

import (
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
)

// clientsGauge tracks active WebSocket sessions for /metrics exposition.
var clientsGauge int64

// promMetrics serves a Prometheus-style exposition matching node/rust, including
// the engine label so multi-engine dashboards distinguish them.
func promMetrics(w http.ResponseWriter, r *http.Request) {
	rssMB := 0.0
	var cpuSeconds float64
	if b, err := os.ReadFile("/proc/self/status"); err == nil {
		for _, line := range strings.Split(string(b), "\n") {
			switch {
			case strings.HasPrefix(line, "VmRSS:"):
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					if v, e := strconv.ParseFloat(fields[1], 64); e == nil {
						rssMB = v / 1024.0 // KiB -> MB
					}
				}
			case strings.HasPrefix(line, "utime:") || strings.HasPrefix(line, "stime:"):
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					if v, e := strconv.ParseFloat(fields[1], 64); e == nil {
						cpuSeconds += v // jiffies -> seconds @100Hz
					}
				}
			}
		}
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	fmt.Fprintf(w, "# HELP tetris_active_sessions Number of active sessions\n# TYPE tetris_active_sessions gauge\ntetris_active_sessions{engine=\"go-engine\"} %d\n\n", atomic.LoadInt64(&clientsGauge))
	fmt.Fprintf(w, "# HELP process_rss_bytes RSS memory in bytes\n# TYPE process_rss_bytes gauge\nprocess_rss_bytes{engine=\"go-engine\"} %d\n\n", uint64(rssMB*1024*1024))
	fmt.Fprintf(w, "# HELP process_cpu_seconds_total Total CPU seconds\n# TYPE process_cpu_seconds_total counter\nprocess_cpu_seconds_total{engine=\"go-engine\"} %.6f\n", cpuSeconds/100.0)
}
