package main

import (
	"os"

	"golang.org/x/sys/windows"
)

// enableANSI turns on ANSI/VT100 escape-code interpretation in the native
// Windows console (cmd.exe, legacy PowerShell hosts) — off by default there,
// unlike every Unix terminal and Windows Terminal (which enables it
// automatically). Without this, printHighlight's color codes render as
// nothing or garbage instead of a highlighted line.
func enableANSI() {
	stdout := windows.Handle(os.Stdout.Fd())
	var mode uint32
	if err := windows.GetConsoleMode(stdout, &mode); err != nil {
		return
	}
	_ = windows.SetConsoleMode(stdout, mode|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING)
}
