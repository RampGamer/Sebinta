//go:build !windows

package main

// enableANSI is a no-op outside Windows: every Unix terminal already
// interprets ANSI escape codes without any setup.
func enableANSI() {}
