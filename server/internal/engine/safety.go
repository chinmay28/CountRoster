package engine

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

// SafetyBundle is one automatic backup taken before a destructive switch.
type SafetyBundle struct {
	Name      string `json:"name"`
	CreatedAt string `json:"created_at"`
	Size      int64  `json:"size"`
}

// SafetyStore keeps the last Keep backup bundles taken before any step that
// overwrites data, in a directory of their own. Names are
// "<UTC stamp, ms>-<reason>.countroster.zip" — sortable, and self-describing in a
// file manager.
type SafetyStore struct {
	Dir  string
	Keep int
	Now  func() time.Time
}

var (
	safetyNameRe = regexp.MustCompile(`^(\d{8}T\d{6}\.\d{3}Z)-([a-z0-9-]{1,40})\.countroster\.zip$`)
	reasonRe     = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)
)

const safetyStamp = "20060102T150405.000Z"

// Save writes data under reason and prunes the oldest beyond Keep.
func (s SafetyStore) Save(reason string, data []byte) (SafetyBundle, error) {
	if !reasonRe.MatchString(reason) {
		return SafetyBundle{}, fmt.Errorf("bad safety bundle reason %q", reason)
	}
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return SafetyBundle{}, err
	}
	name := s.Now().UTC().Format(safetyStamp) + "-" + reason + ".countroster.zip"
	if err := os.WriteFile(filepath.Join(s.Dir, name), data, 0o600); err != nil {
		return SafetyBundle{}, err
	}
	list, err := s.List()
	if err != nil {
		return SafetyBundle{}, err
	}
	for _, old := range list[min(len(list), max(s.Keep, 1)):] {
		os.Remove(filepath.Join(s.Dir, old.Name))
	}
	return SafetyBundle{Name: name, CreatedAt: stampISO(name), Size: int64(len(data))}, nil
}

// List returns the bundles, newest first. A missing directory is no bundles.
func (s SafetyStore) List() ([]SafetyBundle, error) {
	entries, err := os.ReadDir(s.Dir)
	if errors.Is(err, os.ErrNotExist) {
		return []SafetyBundle{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []SafetyBundle{}
	for _, e := range entries {
		if e.IsDir() || !safetyNameRe.MatchString(e.Name()) {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, SafetyBundle{Name: e.Name(), CreatedAt: stampISO(e.Name()), Size: info.Size()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name > out[j].Name })
	return out, nil
}

// Path resolves a bundle name to its file. Only names Save could have
// produced are accepted, so a request can't walk out of the directory.
func (s SafetyStore) Path(name string) (string, error) {
	if !safetyNameRe.MatchString(name) {
		return "", os.ErrNotExist
	}
	p := filepath.Join(s.Dir, name)
	if _, err := os.Stat(p); err != nil {
		return "", err
	}
	return p, nil
}

func stampISO(name string) string {
	m := safetyNameRe.FindStringSubmatch(name)
	if m == nil {
		return ""
	}
	t, err := time.Parse(safetyStamp, m[1])
	if err != nil {
		return ""
	}
	return t.Format("2006-01-02T15:04:05.000Z")
}
