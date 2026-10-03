package engine

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// Mode is where /api requests go.
type Mode string

const (
	// ModeLocal serves /api from the device's own database.
	ModeLocal Mode = "local"
	// ModeRemote proxies /api to a CountRoster server.
	ModeRemote Mode = "remote"
)

// Config is the engine's persisted state. It lives in a JSON file beside the
// database rather than inside it: it must not travel in a backup bundle, and
// it must survive the local database being replaced by an import.
type Config struct {
	Mode      Mode   `json:"mode"`
	RemoteURL string `json:"remote_url,omitempty"`
}

// Validate reports whether c is a state the engine can run in.
func (c Config) Validate() error {
	switch c.Mode {
	case ModeLocal:
		return nil
	case ModeRemote:
		if _, err := NormalizeURL(c.RemoteURL); err != nil {
			return fmt.Errorf("remote mode: %w", err)
		}
		return nil
	default:
		return fmt.Errorf("unknown mode %q", c.Mode)
	}
}

// ConfigStore reads and writes Config at a fixed path.
type ConfigStore struct{ Path string }

// Load returns the stored config. A missing file is the first launch: local
// mode, no error.
func (s ConfigStore) Load() (Config, error) {
	data, err := os.ReadFile(s.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return Config{Mode: ModeLocal}, nil
	}
	if err != nil {
		return Config{}, err
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return Config{}, fmt.Errorf("%s: %w", s.Path, err)
	}
	if err := c.Validate(); err != nil {
		return Config{}, fmt.Errorf("%s: %w", s.Path, err)
	}
	return c, nil
}

// Save writes c atomically (temp file + rename), so a crash mid-write leaves
// either the old config or the new one, never half of each.
func (s ConfigStore) Save(c Config) error {
	if err := c.Validate(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.Path), ".engine-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // no-op once renamed
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), s.Path)
}
