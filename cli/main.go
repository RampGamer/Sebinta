package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(1)
	}
	switch os.Args[1] {
	case "clean":
		cmdClean(os.Args[2:])
	case "send":
		cmdSend(os.Args[2:])
	case "-h", "--help", "help":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", os.Args[1])
		usage()
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `sebinta-clean — strips metadata from Office documents (.docx/.xlsx/.pptx) locally, without depending on the server.

Usage:
  sebinta-clean clean [-o output-file] <file.docx>
      Cleans the file and writes the result (default: <name>.clean.<ext>).
      Never touches the network.

  sebinta-clean send -server URL -pad NAME [-site-password PASS] [-pad-password PASS] <file.docx>
      Cleans the file locally and sends it straight to a Sebinta pad.

Examples:
  sebinta-clean clean report.docx
  sebinta-clean send -server https://notes.example.com -pad project-x report.docx
`)
}

func fatalf(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "error: "+format+"\n", args...)
	os.Exit(1)
}

func isOoxmlExt(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".docx", ".xlsx", ".pptx":
		return true
	}
	return false
}

func printRemoved(removed []string) {
	if len(removed) == 0 {
		fmt.Println("  (no sensitive metadata found)")
		return
	}
	for _, r := range removed {
		fmt.Printf("  removed: %s\n", r)
	}
}

func cmdClean(args []string) {
	fs := flag.NewFlagSet("clean", flag.ExitOnError)
	out := fs.String("o", "", "output file (default: <name>.clean.<ext>)")
	if err := fs.Parse(args); err != nil {
		os.Exit(1)
	}
	rest := fs.Args()
	if len(rest) != 1 {
		fmt.Fprintln(os.Stderr, "usage: sebinta-clean clean [-o output-file] <file>")
		os.Exit(1)
	}
	input := rest[0]
	if !isOoxmlExt(input) {
		fatalf("%q is not a .docx/.xlsx/.pptx — this command only cleans Office OOXML.", input)
	}
	data, err := os.ReadFile(input)
	if err != nil {
		fatalf("could not read %q: %v", input, err)
	}
	cleaned, removed, err := CleanOoxml(data)
	if err != nil {
		fatalf("failed to clean %q: %v", input, err)
	}
	outPath := *out
	if outPath == "" {
		ext := filepath.Ext(input)
		outPath = strings.TrimSuffix(input, ext) + ".clean" + ext
	}
	if err := os.WriteFile(outPath, cleaned, 0o644); err != nil {
		fatalf("could not write %q: %v", outPath, err)
	}
	fmt.Printf("Cleaned: %s\n", outPath)
	printRemoved(removed)
}

func cmdSend(args []string) {
	fs := flag.NewFlagSet("send", flag.ExitOnError)
	server := fs.String("server", "", "Sebinta base URL (e.g.: https://notes.example.com)")
	pad := fs.String("pad", "", "destination pad name")
	sitePassword := fs.String("site-password", "", "site password, if enabled")
	padPassword := fs.String("pad-password", "", "this pad's password, if protected")
	if err := fs.Parse(args); err != nil {
		os.Exit(1)
	}
	rest := fs.Args()
	if *server == "" || *pad == "" || len(rest) != 1 {
		fmt.Fprintln(os.Stderr, "usage: sebinta-clean send -server URL -pad NAME [-site-password P] [-pad-password P] <file>")
		os.Exit(1)
	}
	input := rest[0]
	data, err := os.ReadFile(input)
	if err != nil {
		fatalf("could not read %q: %v", input, err)
	}

	uploadData := data
	uploadName := filepath.Base(input)
	if isOoxmlExt(input) {
		cleaned, removed, err := CleanOoxml(data)
		if err != nil {
			fatalf("failed to clean %q: %v", input, err)
		}
		uploadData = cleaned
		fmt.Println("Local cleanup:")
		printRemoved(removed)
	} else {
		fmt.Printf("Warning: %q is not Office OOXML — there's no local cleanup for this type; the server still quarantine-scans it before it becomes reachable.\n", input)
	}

	client, err := NewSebintaClient(*server)
	if err != nil {
		fatalf("invalid server: %v", err)
	}
	if err := client.EnsureCsrf(); err != nil {
		fatalf("could not connect to the server: %v", err)
	}
	if *sitePassword != "" {
		if err := client.SiteLogin(*sitePassword); err != nil {
			fatalf("site password rejected: %v", err)
		}
	}
	if *padPassword != "" {
		if err := client.UnlockPad(*pad, *padPassword); err != nil {
			fatalf("pad password rejected: %v", err)
		}
	}
	fileID, err := client.UploadFile(*pad, uploadName, uploadData)
	if err != nil {
		fatalf("upload failed: %v", err)
	}
	fmt.Printf("Sent to pad %q (file id: %s)\n", *pad, fileID)
}
